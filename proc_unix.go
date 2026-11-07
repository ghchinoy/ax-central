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

//go:build !windows

package main

import (
	"os/exec"
	"syscall"
	"time"
)

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func (s *Shell) terminateStreamProcess(id string, cmd *exec.Cmd) {
	pid := cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGINT)
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	go func() {
		time.Sleep(100 * time.Millisecond)
		s.mu.Lock()
		stillRunning := s.streams[id] == cmd
		s.mu.Unlock()
		if stillRunning {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}
	}()
}

func (s *Shell) terminateSessionProcess(id string, cmd *exec.Cmd) {
	pid := cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	go func() {
		time.Sleep(100 * time.Millisecond)
		s.mu.Lock()
		sess := s.sessions[id]
		stillRunning := sess != nil && sess.cmd == cmd
		s.mu.Unlock()
		if stillRunning {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}
	}()
}
