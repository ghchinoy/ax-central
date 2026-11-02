// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed docker-shim.sh
var dockerShimScript []byte

// CommandResult is the outcome of a synchronous command execution.
type CommandResult struct {
	Status int    `json:"status"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

// RunRequest describes a command to run to completion.
type RunRequest struct {
	Program string            `json:"program"`
	Args    []string          `json:"args"`
	Stdin   string            `json:"stdin"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
}

// StreamRequest describes a shell command whose output lines are streamed.
type StreamRequest struct {
	ID          string            `json:"id"`
	CommandLine string            `json:"commandLine"`
	Cwd         string            `json:"cwd"`
	Env         map[string]string `json:"env"`
}

// StreamLine is a single line emitted by a streamed command.
type StreamLine struct {
	ID   string `json:"id"`
	Line string `json:"line"`
}

// StreamExit is emitted when a streamed command or session exits.
type StreamExit struct {
	ID     string `json:"id"`
	Status int    `json:"status"`
}

// SessionRequest describes an interactive stdio session.
type SessionRequest struct {
	ID      string   `json:"id"`
	Program string   `json:"program"`
	Args    []string `json:"args"`
}

// SessionData is a raw chunk of stdout or stderr from an interactive session.
type SessionData struct {
	ID     string `json:"id"`
	Data   string `json:"data"`
	Stream string `json:"stream"`
}

// ContainerRuntimeInfo describes the detected container runtime (docker or podman).
type ContainerRuntimeInfo struct {
	Runtime string            `json:"runtime"`
	Env     map[string]string `json:"env"`
}

type activeSession struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	mu    sync.Mutex
}

// Shell manages subprocess execution, streaming pipelines, and interactive sessions.
type Shell struct {
	pathEnv  string
	mu       sync.Mutex
	streams  map[string]*exec.Cmd
	sessions map[string]*activeSession
}

// NewShell initializes a Shell with the user's login PATH merged with common tool directories.
func NewShell() *Shell {
	return &Shell{
		pathEnv:  buildLoginPath(),
		streams:  make(map[string]*exec.Cmd),
		sessions: make(map[string]*activeSession),
	}
}

func buildLoginPath() string {
	base := os.Getenv("PATH")
	home, _ := os.UserHomeDir()
	sep := string(os.PathListSeparator)

	var login string
	if runtime.GOOS != "windows" {
		sh := os.Getenv("SHELL")
		if sh == "" {
			sh = "/bin/zsh"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, sh, "-ilc", `printf "__AXPATH__%s" "$PATH"`).Output()
		if err == nil {
			s := string(out)
			if i := strings.LastIndex(s, "__AXPATH__"); i >= 0 {
				login = strings.TrimSpace(s[i+len("__AXPATH__"):])
			}
		}
	}

	var extra []string
	if runtime.GOOS == "windows" {
		extra = []string{
			filepath.Join(home, "go", "bin"),
			filepath.Join(home, "scoop", "shims"),
		}
	} else {
		extra = []string{
			filepath.Join(home, "go", "bin"),
			filepath.Join(home, ".local", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/usr/local/go/bin",
			filepath.Join(home, "google-cloud-sdk", "bin"),
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		}
	}

	seen := make(map[string]bool)
	var parts []string
	add := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir != "" && !seen[dir] {
			seen[dir] = true
			parts = append(parts, dir)
		}
	}
	for _, p := range strings.Split(login, sep) {
		add(p)
	}
	for _, p := range strings.Split(base, sep) {
		add(p)
	}
	for _, p := range extra {
		add(p)
	}
	return strings.Join(parts, sep)
}

// ExpandPath replaces a leading "~" with the user's home directory.
func ExpandPath(p string) string {
	if strings.HasPrefix(p, "~") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}

// Which resolves program against the Shell's PATH, returning "" when not found.
func (s *Shell) Which(program string) string {
	if program == "" {
		return ""
	}
	program = ExpandPath(program)
	if strings.ContainsAny(program, `/\`) {
		if info, err := os.Stat(program); err == nil && !info.IsDir() {
			return program
		}
		return ""
	}
	sep := string(os.PathListSeparator)
	exts := []string{""}
	if runtime.GOOS == "windows" {
		pathext := os.Getenv("PATHEXT")
		if pathext == "" {
			pathext = ".EXE;.CMD;.BAT"
		}
		exts = append(strings.Split(pathext, ";"), "")
	}
	for _, dir := range strings.Split(s.pathEnv, sep) {
		for _, ext := range exts {
			candidate := filepath.Join(dir, program+ext)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return ""
}

func (s *Shell) mergeEnv(overrides map[string]string) []string {
	envMap := make(map[string]string)
	for _, kv := range os.Environ() {
		if idx := strings.IndexByte(kv, '='); idx > 0 {
			envMap[kv[:idx]] = kv[idx+1:]
		}
	}
	envMap["PATH"] = s.pathEnv
	for k, v := range overrides {
		envMap[k] = v
	}
	out := make([]string, 0, len(envMap))
	for k, v := range envMap {
		out = append(out, k+"="+v)
	}
	return out
}

// Run executes a command to completion and returns its status, stdout, and stderr.
func (s *Shell) Run(req RunRequest) CommandResult {
	prog := s.Which(req.Program)
	if prog == "" {
		prog = req.Program
	}
	cmd := exec.Command(prog, req.Args...)
	if req.Cwd != "" {
		cmd.Dir = ExpandPath(req.Cwd)
	}
	cmd.Env = s.mergeEnv(req.Env)
	if req.Stdin != "" {
		cmd.Stdin = strings.NewReader(req.Stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	status := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			status = exitErr.ExitCode()
		} else {
			status = 127
			if stderr.Len() > 0 && !strings.HasSuffix(stderr.String(), "\n") {
				stderr.WriteByte('\n')
			}
			fmt.Fprintf(&stderr, "%s: %v", req.Program, err)
		}
	}
	return CommandResult{
		Status: status,
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
}

func (s *Shell) shellCommand(commandLine string) (string, []string) {
	if runtime.GOOS != "windows" {
		return "/bin/sh", []string{"-c", commandLine}
	}
	if bash := s.Which("bash"); bash != "" {
		return bash, []string{"-lc", commandLine}
	}
	return "cmd.exe", []string{"/d", "/s", "/c", commandLine}
}

// Stream spawns a shell command in its own process group and calls onLine for each line and onExit when done.
func (s *Shell) Stream(req StreamRequest, onLine func(string), onExit func(int)) {
	prog, args := s.shellCommand(req.CommandLine)
	cmd := exec.Command(prog, args...)
	if req.Cwd != "" {
		cmd.Dir = ExpandPath(req.Cwd)
	}
	cmd.Env = s.mergeEnv(req.Env)
	setProcessGroup(cmd)

	stdoutPipe, errOut := cmd.StdoutPipe()
	stderrPipe, errErr := cmd.StderrPipe()
	if errOut != nil || errErr != nil {
		onLine("error: failed to create stdio pipes")
		onExit(1)
		return
	}

	s.mu.Lock()
	s.streams[req.ID] = cmd
	s.mu.Unlock()

	if err := cmd.Start(); err != nil {
		s.mu.Lock()
		delete(s.streams, req.ID)
		s.mu.Unlock()
		onLine(fmt.Sprintf("error: %v", err))
		onExit(127)
		return
	}

	var lineMu sync.Mutex
	emitLine := func(line string) {
		lineMu.Lock()
		defer lineMu.Unlock()
		onLine(line)
	}

	var wg sync.WaitGroup
	scanPipe := func(r io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(r)
		// Increase max token size to 1 MiB for long JSON log lines from kubectl.
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			emitLine(strings.TrimSuffix(scanner.Text(), "\r"))
		}
	}

	wg.Add(2)
	go scanPipe(stdoutPipe)
	go scanPipe(stderrPipe)

	go func() {
		wg.Wait()
		err := cmd.Wait()
		s.mu.Lock()
		delete(s.streams, req.ID)
		s.mu.Unlock()

		status := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				status = exitErr.ExitCode()
				if status < 0 {
					status = 130
				}
			} else {
				status = 1
			}
		}
		onExit(status)
	}()
}

// Cancel stops an active stream by sending SIGINT and SIGTERM to its process group,
// escalating to SIGKILL if the process group does not exit promptly.
func (s *Shell) Cancel(id string) {
	s.mu.Lock()
	cmd := s.streams[id]
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	s.terminateStreamProcess(id, cmd)
}

// StartSession starts an interactive program with piped stdio and streams raw chunks.
func (s *Shell) StartSession(req SessionRequest, onData func(data string, stream string), onExit func(status int)) {
	prog := s.Which(req.Program)
	if prog == "" {
		prog = req.Program
	}
	cmd := exec.Command(prog, req.Args...)
	cmd.Env = s.mergeEnv(map[string]string{"TERM": "dumb"})

	stdinPipe, errIn := cmd.StdinPipe()
	stdoutPipe, errOut := cmd.StdoutPipe()
	stderrPipe, errErr := cmd.StderrPipe()
	if errIn != nil || errOut != nil || errErr != nil {
		onData(fmt.Sprintf("%s: failed to open stdio pipes\n", req.Program), "stderr")
		onExit(1)
		return
	}

	sess := &activeSession{cmd: cmd, stdin: stdinPipe}
	s.mu.Lock()
	s.sessions[req.ID] = sess
	s.mu.Unlock()

	if err := cmd.Start(); err != nil {
		s.mu.Lock()
		delete(s.sessions, req.ID)
		s.mu.Unlock()
		onData(fmt.Sprintf("%s: %v\n", req.Program, err), "stderr")
		onExit(127)
		return
	}

	var dataMu sync.Mutex
	emitData := func(chunk string, streamName string) {
		dataMu.Lock()
		defer dataMu.Unlock()
		onData(chunk, streamName)
	}

	var wg sync.WaitGroup
	readChunks := func(r io.Reader, streamName string) {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				emitData(string(buf[:n]), streamName)
			}
			if err != nil {
				return
			}
		}
	}

	wg.Add(2)
	go readChunks(stdoutPipe, "stdout")
	go readChunks(stderrPipe, "stderr")

	go func() {
		wg.Wait()
		err := cmd.Wait()
		s.mu.Lock()
		delete(s.sessions, req.ID)
		s.mu.Unlock()

		status := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				status = exitErr.ExitCode()
				if status < 0 {
					status = 130
				}
			} else {
				status = 1
			}
		}
		onExit(status)
	}()
}

// WriteSession writes raw input to an active session's stdin.
func (s *Shell) WriteSession(id string, data string) {
	s.mu.Lock()
	sess := s.sessions[id]
	s.mu.Unlock()
	if sess == nil {
		return
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.stdin != nil {
		_, _ = io.WriteString(sess.stdin, data)
	}
}

// InterruptSession sends SIGINT to an active session.
func (s *Shell) InterruptSession(id string) {
	s.mu.Lock()
	sess := s.sessions[id]
	s.mu.Unlock()
	if sess == nil || sess.cmd == nil || sess.cmd.Process == nil {
		return
	}
	_ = sess.cmd.Process.Signal(os.Interrupt)
}

// EndSessionInput closes the stdin pipe of an active session.
func (s *Shell) EndSessionInput(id string) {
	s.mu.Lock()
	sess := s.sessions[id]
	s.mu.Unlock()
	if sess == nil {
		return
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.stdin != nil {
		_ = sess.stdin.Close()
		sess.stdin = nil
	}
}

// CloseSession kills an active session.
func (s *Shell) CloseSession(id string) {
	s.mu.Lock()
	sess := s.sessions[id]
	s.mu.Unlock()
	if sess == nil || sess.cmd == nil || sess.cmd.Process == nil {
		return
	}
	_ = sess.cmd.Process.Kill()
}

// CancelAll stops all active streams and sessions.
func (s *Shell) CancelAll() {
	s.mu.Lock()
	streamIDs := make([]string, 0, len(s.streams))
	for id := range s.streams {
		streamIDs = append(streamIDs, id)
	}
	sessionIDs := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		sessionIDs = append(sessionIDs, id)
	}
	s.mu.Unlock()

	for _, id := range streamIDs {
		s.Cancel(id)
	}
	for _, id := range sessionIDs {
		s.CloseSession(id)
	}
}

var nonWordRe = regexp.MustCompile(`[^\w.-]`)

// KubeconfigFor writes a temporary kubeconfig setting current-context and prepends it to KUBECONFIG.
func (s *Shell) KubeconfigFor(kubeContext string) string {
	safe := nonWordRe.ReplaceAllString(kubeContext, "_")
	file := filepath.Join(os.TempDir(), fmt.Sprintf("axcentral-kubeconfig-%s.yaml", safe))
	quoted, _ := json.Marshal(kubeContext)
	content := fmt.Sprintf("apiVersion: v1\nkind: Config\ncurrent-context: %s\n", string(quoted))
	_ = os.WriteFile(file, []byte(content), 0o600)

	base := os.Getenv("KUBECONFIG")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".kube", "config")
	}
	return file + string(os.PathListSeparator) + base
}

// ContainerRuntime detects docker or podman and installs the docker-shim on podman-only machines.
func (s *Shell) ContainerRuntime(shimDir string) ContainerRuntimeInfo {
	if s.Which("docker") != "" {
		return ContainerRuntimeInfo{Runtime: "docker", Env: map[string]string{}}
	}
	if s.Which("podman") == "" {
		return ContainerRuntimeInfo{Runtime: "", Env: map[string]string{}}
	}
	if runtime.GOOS == "windows" {
		return ContainerRuntimeInfo{
			Runtime: "podman",
			Env:     map[string]string{"KIND_EXPERIMENTAL_PROVIDER": "podman"},
		}
	}
	_ = os.MkdirAll(shimDir, 0o755)
	shimPath := filepath.Join(shimDir, "docker")
	_ = os.WriteFile(shimPath, dockerShimScript, 0o755)
	_ = os.Chmod(shimPath, 0o755)
	return ContainerRuntimeInfo{
		Runtime: "podman",
		Env: map[string]string{
			"PATH":                       shimDir + string(os.PathListSeparator) + s.pathEnv,
			"KIND_EXPERIMENTAL_PROVIDER": "podman",
		},
	}
}
