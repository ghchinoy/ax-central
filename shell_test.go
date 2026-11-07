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
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestShellRunAndWhich(t *testing.T) {
	sh := NewShell()
	if got := sh.Which("sh"); got == "" {
		t.Fatalf("sh.Which(%q) = %q, want non-empty path", "sh", got)
	}
	if got := sh.Which("nonexistent-ax-binary-xyz"); got != "" {
		t.Fatalf("sh.Which(%q) = %q, want %q", "nonexistent-ax-binary-xyz", got, "")
	}

	req := RunRequest{
		Program: "sh",
		Args:    []string{"-c", "cat && echo $CUSTOM_VAR"},
		Stdin:   "hello ",
		Env:     map[string]string{"CUSTOM_VAR": "world"},
	}
	res := sh.Run(req)
	if res.Status != 0 {
		t.Fatalf("sh.Run(%+v) status = %d, want 0 (stderr: %q)", req, res.Status, res.Stderr)
	}
	if got := strings.TrimSpace(res.Stdout); got != "hello world" {
		t.Fatalf("sh.Run(%+v) stdout = %q, want %q", req, got, "hello world")
	}

	missingReq := RunRequest{Program: "nonexistent-ax-binary-xyz"}
	missing := sh.Run(missingReq)
	if missing.Status == 0 {
		t.Fatalf("sh.Run(%+v) status = %d, want non-zero", missingReq, missing.Status)
	}
}

func TestShellStreamAndCancel(t *testing.T) {
	sh := NewShell()
	var mu sync.Mutex
	var lines []string
	done := make(chan int, 1)

	req := StreamRequest{
		ID:          "s1",
		CommandLine: "printf 'alpha\\nbeta\\n'",
	}
	sh.Stream(
		req,
		func(line string) {
			mu.Lock()
			lines = append(lines, line)
			mu.Unlock()
		},
		func(status int) {
			done <- status
		},
	)

	select {
	case status := <-done:
		if status != 0 {
			t.Fatalf("sh.Stream(%+v) exit status = %d, want 0", req, status)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("sh.Stream(%+v) timed out after 5s, want completion", req)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(lines) != 2 || lines[0] != "alpha" || lines[1] != "beta" {
		t.Fatalf("sh.Stream(%+v) lines = %v, want [alpha beta]", req, lines)
	}
}

func TestShellCancelRunningStream(t *testing.T) {
	sh := NewShell()
	started := make(chan struct{}, 1)
	done := make(chan int, 1)

	req := StreamRequest{
		ID:          "s-cancel",
		CommandLine: "trap '' INT; echo ready; sleep 30",
	}
	sh.Stream(
		req,
		func(line string) {
			if line == "ready" {
				select {
				case started <- struct{}{}:
				default:
				}
			}
		},
		func(status int) {
			done <- status
		},
	)

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatalf("sh.Stream(%+v) did not emit ready line within 5s", req)
	}

	sh.Cancel("s-cancel")

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("sh.Cancel(%q) did not terminate stream within 5s", "s-cancel")
	}
}

func TestShellInteractiveSession(t *testing.T) {
	sh := NewShell()
	var mu sync.Mutex
	var out strings.Builder
	gotLine := make(chan struct{}, 1)
	done := make(chan int, 1)

	req := SessionRequest{
		ID:      "sess-1",
		Program: "sh",
		Args:    []string{"-c", "read line && echo \"reply:$line\""},
	}
	sh.StartSession(
		req,
		func(data string, _ string) {
			mu.Lock()
			out.WriteString(data)
			if strings.Contains(out.String(), "reply:ping") {
				select {
				case gotLine <- struct{}{}:
				default:
				}
			}
			mu.Unlock()
		},
		func(status int) {
			done <- status
		},
	)

	sh.WriteSession("sess-1", "ping\n")
	sh.EndSessionInput("sess-1")

	select {
	case <-gotLine:
	case <-time.After(5 * time.Second):
		t.Fatalf("sh.StartSession(%+v) output = %q, want substring %q", req, out.String(), "reply:ping")
	}

	select {
	case status := <-done:
		if status != 0 {
			t.Fatalf("sh.StartSession(%+v) exit status = %d, want 0", req, status)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("sh.StartSession(%+v) did not exit within 5s", req)
	}
}

func TestKubeconfigForAndExpandPath(t *testing.T) {
	sh := NewShell()
	kc := sh.KubeconfigFor("kind-ax-dev")
	parts := strings.Split(kc, string(os.PathListSeparator))
	if len(parts) < 2 {
		t.Fatalf("sh.KubeconfigFor(%q) = %q, want at least 2 path entries", "kind-ax-dev", kc)
	}
	if !strings.Contains(parts[0], filepath.Join("ax-central", "kubeconfigs")) {
		t.Fatalf("sh.KubeconfigFor(%q) path = %q, want path under ax-central/kubeconfigs", "kind-ax-dev", parts[0])
	}
	info, err := os.Stat(parts[0])
	if err != nil {
		t.Fatalf("os.Stat(%q) = %v, want nil", parts[0], err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("os.Stat(%q) perm = %o, want 0600", parts[0], perm)
	}
	data, err := os.ReadFile(parts[0])
	if err != nil {
		t.Fatalf("os.ReadFile(%q) = %v, want nil", parts[0], err)
	}
	if !strings.Contains(string(data), `current-context: "kind-ax-dev"`) {
		t.Fatalf("sh.KubeconfigFor(%q) file content = %q, want current-context kind-ax-dev", "kind-ax-dev", string(data))
	}

	home, _ := os.UserHomeDir()
	wantPath := filepath.Join(home, "ax")
	if got := ExpandPath("~/ax"); got != wantPath {
		t.Fatalf("ExpandPath(%q) = %q, want %q", "~/ax", got, wantPath)
	}
}

func TestShellCloseSessionProcessGroup(t *testing.T) {
	sh := NewShell()
	started := make(chan struct{}, 1)
	done := make(chan int, 1)

	req := SessionRequest{
		ID:      "sess-close",
		Program: "sh",
		Args:    []string{"-c", "echo ready; sleep 30"},
	}
	sh.StartSession(
		req,
		func(data string, _ string) {
			if strings.Contains(data, "ready") {
				select {
				case started <- struct{}{}:
				default:
				}
			}
		},
		func(status int) {
			done <- status
		},
	)

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatalf("sh.StartSession(%+v) did not emit ready within 5s", req)
	}

	sh.CloseSession("sess-close")

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("sh.CloseSession(%q) did not terminate session within 5s", "sess-close")
	}
}

func TestDoctorScriptJSON(t *testing.T) {
	sh := NewShell()
	req := RunRequest{
		Program: "bash",
		Args:    []string{"hack/doctor.sh", "--json"},
	}
	res := sh.Run(req)
	if res.Status != 0 {
		t.Fatalf("sh.Run(%+v) status = %d, want 0 (stderr: %q)", req, res.Status, res.Stderr)
	}
	if !strings.Contains(res.Stdout, `"checks":[`) || !strings.Contains(res.Stdout, `"ax-repo-variant"`) {
		t.Fatalf("sh.Run(%+v) stdout = %q, want checks array with ax-repo-variant", req, res.Stdout)
	}
}

func TestLiveCrostiniKindClusterE2E(t *testing.T) {
	sh := NewShell()
	home, _ := os.UserHomeDir()
	kcPath := filepath.Join(home, "projects", "ax", ".tmp", "kubeconfig-ax-e2e")
	if _, err := os.Stat(kcPath); err != nil {
		t.Skipf("skipping live Crostini Kind E2E test: %s not found", kcPath)
	}
	axBin := sh.Which("ax")
	if axBin == "" {
		t.Skip("skipping live Crostini Kind E2E test: ax binary not found on Shell PATH")
	}
	clustersRes := sh.Run(RunRequest{Program: "kind", Args: []string{"get", "clusters"}})
	if clustersRes.Status != 0 || !strings.Contains(clustersRes.Stdout, "ax-e2e") {
		t.Skip("skipping live Crostini Kind E2E test: kind cluster ax-e2e not running")
	}

	env := map[string]string{"KUBECONFIG": kcPath}
	stamp := time.Now().UnixNano()
	taskName := fmt.Sprintf("axcentral-e2e-task-%d", stamp)
	wsName := fmt.Sprintf("axcentral-e2e-ws-%d", stamp)
	_ = sh.Run(RunRequest{
		Program: axBin,
		Args:    []string{"--context", "kind-ax-e2e", "-a", "default", "delete", "task", "axcentral-e2e-task"},
		Env:     env,
	})
	_ = sh.Run(RunRequest{
		Program: axBin,
		Args:    []string{"--context", "kind-ax-e2e", "-a", "default", "delete", "workspace", "axcentral-e2e-ws"},
		Env:     env,
	})
	t.Cleanup(func() {
		_ = sh.Run(RunRequest{
			Program: axBin,
			Args:    []string{"--context", "kind-ax-e2e", "-a", "default", "delete", "task", taskName},
			Env:     env,
		})
		_ = sh.Run(RunRequest{
			Program: axBin,
			Args:    []string{"--context", "kind-ax-e2e", "-a", "default", "delete", "workspace", wsName},
			Env:     env,
		})
	})

	manifest := "apiVersion: ax.io/v1alpha1\nkind: Workspace\nmetadata:\n  name: " + wsName + "\n  atespace: default\nspec:\n  files:\n    - path: NOTE.txt\n      content: \"verified-by-ax-central\"\n---\napiVersion: ax.io/v1alpha1\nkind: Task\nmetadata:\n  name: " + taskName + "\n  atespace: default\nspec:\n  workspace:\n    name: " + wsName + "\n  debug: true\n"
	applyRes := sh.Run(RunRequest{
		Program: axBin,
		Args:    []string{"--context", "kind-ax-e2e", "-a", "default", "apply", "-f", "-"},
		Stdin:   manifest,
		Env:     env,
	})
	if applyRes.Status != 0 {
		t.Fatalf("sh.Run(ax apply) status = %d, want 0 (stderr: %q)", applyRes.Status, applyRes.Stderr)
	}

	resumeRes := sh.Run(RunRequest{
		Program: axBin,
		Args:    []string{"--context", "kind-ax-e2e", "-a", "default", "resume", "task", taskName},
		Env:     env,
	})
	if resumeRes.Status != 0 {
		t.Fatalf("sh.Run(ax resume) status = %d, want 0 (stderr: %q)", resumeRes.Status, resumeRes.Stderr)
	}

	// Verify interactive StartSession (ax ssh) with Env{"KUBECONFIG": kcPath}
	var mu sync.Mutex
	var sshOut strings.Builder
	gotSSH := make(chan struct{}, 1)
	sshDone := make(chan int, 1)
	sessReq := SessionRequest{
		ID:      "sess-crostini-e2e",
		Program: axBin,
		Args:    []string{"--context", "kind-ax-e2e", "-a", "default", "ssh", taskName, "--", "sh", "-c", "cat /workspace/NOTE.txt"},
		Env:     env,
	}
	sh.StartSession(
		sessReq,
		func(data string, _ string) {
			mu.Lock()
			sshOut.WriteString(data)
			if strings.Contains(sshOut.String(), "verified-by-ax-central") {
				select {
				case gotSSH <- struct{}{}:
				default:
				}
			}
			mu.Unlock()
		},
		func(status int) {
			sshDone <- status
		},
	)

	sh.EndSessionInput("sess-crostini-e2e")

	select {
	case <-gotSSH:
	case <-time.After(15 * time.Second):
		mu.Lock()
		got := sshOut.String()
		mu.Unlock()
		t.Fatalf("sh.StartSession(%+v) output = %q, want substring %q", sessReq, got, "verified-by-ax-central")
	}

	select {
	case status := <-sshDone:
		if status != 0 {
			t.Fatalf("sh.StartSession(%+v) exit status = %d, want 0", sessReq, status)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("sh.StartSession(%+v) did not exit within 10s", sessReq)
	}

	suspendRes := sh.Run(RunRequest{
		Program: axBin,
		Args:    []string{"--context", "kind-ax-e2e", "-a", "default", "suspend", "task", taskName},
		Env:     env,
	})
	if suspendRes.Status != 0 {
		t.Fatalf("sh.Run(ax suspend) status = %d, want 0 (stderr: %q)", suspendRes.Status, suspendRes.Stderr)
	}
}
