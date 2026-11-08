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
	"context"
	"os"
	"path/filepath"
	"runtime"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var appVersion = "0.4.2"

// PlatformInfo describes the host environment for the frontend.
type PlatformInfo struct {
	OS            string `json:"os"`
	Home          string `json:"home"`
	PathSeparator string `json:"pathSeparator"`
	Version       string `json:"version"`
}

// YAMLFile holds a YAML file path and its contents from an open dialog.
type YAMLFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

// TrayTask describes a task item in the summary.
type TrayTask struct {
	Name    string   `json:"name"`
	Actions []string `json:"actions"`
}

// TrayGroup groups tasks by phase in the summary.
type TrayGroup struct {
	Phase string     `json:"phase"`
	Tasks []TrayTask `json:"tasks"`
}

// TraySummary summarizes the current atespace's task status.
type TraySummary struct {
	Scope  string      `json:"scope"`
	Status string      `json:"status"`
	Groups []TrayGroup `json:"groups"`
}

// App is bound to the Wails frontend.
type App struct {
	ctx   context.Context
	shell *Shell
}

// NewApp creates a new App instance with an initialized Shell.
func NewApp() *App {
	return &App{
		shell: NewShell(),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) shutdown(_ context.Context) {
	a.shell.CancelAll()
}

func (a *App) emitMenu(action string) {
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "menu", action)
	}
}

// Platform returns host OS, home directory, PATH list separator, and version.
func (a *App) Platform() PlatformInfo {
	home, _ := os.UserHomeDir()
	return PlatformInfo{
		OS:            runtime.GOOS,
		Home:          home,
		PathSeparator: string(os.PathListSeparator),
		Version:       appVersion,
	}
}

// Run executes a subprocess and returns its exit code, stdout, and stderr.
func (a *App) Run(req RunRequest) CommandResult {
	return a.shell.Run(req)
}

// Pipe connects two subprocesses via an OS pipe and returns the combined exit status, stdout, and stderr.
func (a *App) Pipe(req PipeRequest) CommandResult {
	return a.shell.Pipe(req)
}

// Stream starts a line-streamed shell command and emits "stream:line" and "stream:exit" events.
func (a *App) Stream(req StreamRequest) {
	a.shell.Stream(
		req,
		func(line string) {
			if a.ctx != nil {
				wailsruntime.EventsEmit(a.ctx, "stream:line", StreamLine{ID: req.ID, Line: line})
			}
		},
		func(status int) {
			if a.ctx != nil {
				wailsruntime.EventsEmit(a.ctx, "stream:exit", StreamExit{ID: req.ID, Status: status})
			}
		},
	)
}

// CancelStream cancels an active streamed command.
func (a *App) CancelStream(id string) {
	a.shell.Cancel(id)
}

// StartSession starts an interactive stdio session (such as `ax ssh`) and emits "session:data" and "session:exit".
func (a *App) StartSession(req SessionRequest) {
	a.shell.StartSession(
		req,
		func(data string, stream string) {
			if a.ctx != nil {
				wailsruntime.EventsEmit(a.ctx, "session:data", SessionData{ID: req.ID, Data: data, Stream: stream})
			}
		},
		func(status int) {
			if a.ctx != nil {
				wailsruntime.EventsEmit(a.ctx, "session:exit", StreamExit{ID: req.ID, Status: status})
			}
		},
	)
}

// WriteSession sends input data to an interactive session's stdin.
func (a *App) WriteSession(id string, data string) {
	a.shell.WriteSession(id, data)
}

// InterruptSession sends SIGINT to an interactive session.
func (a *App) InterruptSession(id string) {
	a.shell.InterruptSession(id)
}

// EndSessionInput closes stdin on an interactive session (Ctrl-D / EOF).
func (a *App) EndSessionInput(id string) {
	a.shell.EndSessionInput(id)
}

// CloseSession terminates an interactive session.
func (a *App) CloseSession(id string) {
	a.shell.CloseSession(id)
}

// Which resolves an executable on the login shell PATH, returning "" if not found.
func (a *App) Which(program string) string {
	return a.shell.Which(program)
}

// KubeconfigFor writes a temporary kubeconfig that sets current-context and returns a merged KUBECONFIG value.
func (a *App) KubeconfigFor(kubeContext string) string {
	return a.shell.KubeconfigFor(kubeContext)
}

// FileExists reports whether path (expanding leading ~) exists.
func (a *App) FileExists(path string) bool {
	_, err := os.Stat(ExpandPath(path))
	return err == nil
}

// ContainerRuntime detects docker or podman and sets up the podman shim if needed.
func (a *App) ContainerRuntime() ContainerRuntimeInfo {
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		cfgDir = os.TempDir()
	}
	shimDir := filepath.Join(cfgDir, "ax-central", "bin")
	return a.shell.ContainerRuntime(shimDir)
}

// OpenYAML opens a native file picker for YAML manifests and returns its path and contents.
func (a *App) OpenYAML(defaultDir string) (*YAMLFile, error) {
	if a.ctx == nil {
		return nil, nil
	}
	dir := ExpandPath(defaultDir)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		dir = ""
	}
	file, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		DefaultDirectory: dir,
		Title:            "Open YAML Manifest",
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "YAML (*.yaml, *.yml)", Pattern: "*.yaml;*.yml"},
		},
	})
	if err != nil || file == "" {
		return nil, nil
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	return &YAMLFile{Path: file, Text: string(data)}, nil
}

// SaveYAML opens a native save dialog for a YAML manifest and writes text to the chosen file.
func (a *App) SaveYAML(name string, text string) (string, error) {
	if a.ctx == nil {
		return "", nil
	}
	file, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		DefaultFilename: name,
		Title:           "Save YAML Manifest",
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "YAML (*.yaml)", Pattern: "*.yaml;*.yml"},
		},
	})
	if err != nil || file == "" {
		return "", nil
	}
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		return "", err
	}
	return file, nil
}

// UpdateTray accepts a task summary from the frontend (no-op on Wails v2 native app menu).
func (a *App) UpdateTray(_ TraySummary) {}
