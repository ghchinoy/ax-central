#!/usr/bin/env bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# hack/doctor.sh audits and optionally bootstraps prerequisites for AX Central:
#   - Tier A (macOS Apple Container / ate-local stack + ax-experiments)
#   - Tier B (Local Kubernetes / Kind + Agent Substrate stack)
#
# Usage:
#   hack/doctor.sh [--json] [--install [target]]

set -euo pipefail

AX_REPO="${AX_REPO:-$HOME/projects/ax}"
AX_REPO="${AX_REPO/#\~/$HOME}"
AX_EXPERIMENTS_REPO="${AX_EXPERIMENTS_REPO:-$HOME/projects/ax-experiments}"
AX_EXPERIMENTS_REPO="${AX_EXPERIMENTS_REPO/#\~/$HOME}"

MODE="human"
INSTALL_TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      MODE="json"
      shift
      ;;
    --install)
      MODE="install"
      if [[ $# -gt 1 && "$2" != --* ]]; then
        INSTALL_TARGET="$2"
        shift 2
      else
        INSTALL_TARGET="all"
        shift
      fi
      ;;
    -h|--help)
      echo "Usage: hack/doctor.sh [--json] [--install [all|wails|container-daemon|ax-repo|ate-local-bins|ax-experiments|agent-image]]"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

install_target() {
  local target="$1"
  case "$target" in
    wails)
      if [[ "$(uname -s)" == "Linux" ]] && command -v apt-get >/dev/null 2>&1; then
        if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists gtk+-3.0 || ( ! pkg-config --exists webkit2gtk-4.1 && ! pkg-config --exists webkit2gtk-4.0 ); then
          echo "==> Installing Linux GTK3 & WebKit2GTK 4.1 development libraries..."
          sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
          sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libgtk-3-dev libwebkit2gtk-4.1-dev pkg-config build-essential
        fi
      fi
      echo "==> Installing latest Wails CLI..."
      go install github.com/wailsapp/wails/v2/cmd/wails@latest
      if [[ -x "$HOME/go/bin/wails" && -w /usr/local/bin ]]; then
        ln -sf "$HOME/go/bin/wails" /usr/local/bin/wails || true
      elif [[ -x "$HOME/go/bin/wails" ]] && sudo -n true 2>/dev/null; then
        sudo ln -sf "$HOME/go/bin/wails" /usr/local/bin/wails || true
      fi
      ;;
    container-daemon)
      echo "==> Starting Apple container daemon..."
      container system start
      ;;
    ax-repo)
      if [[ ! -d "$AX_REPO/.git" ]]; then
        echo "==> Cloning ghchinoy/ax (feat/ate-local-apple-container) into $AX_REPO..."
        git clone -b feat/ate-local-apple-container https://github.com/ghchinoy/ax.git "$AX_REPO"
      else
        echo "==> Ensuring feat/ate-local-apple-container is available in $AX_REPO..."
        (
          cd "$AX_REPO"
          if ! git remote get-url ghchinoy >/dev/null 2>&1 && ! git remote get-url origin 2>/dev/null | grep -q "ghchinoy/ax"; then
            git remote add ghchinoy https://github.com/ghchinoy/ax.git || true
            git fetch ghchinoy feat/ate-local-apple-container
            git checkout -B feat/ate-local-apple-container ghchinoy/feat/ate-local-apple-container
          else
            git fetch origin feat/ate-local-apple-container || true
            git checkout feat/ate-local-apple-container
          fi
        )
      fi
      ;;
    ate-local-bins)
      echo "==> Building ate-local, ax-server, ax, and linux/arm64 ax-task-runner in $AX_REPO..."
      (
        cd "$AX_REPO"
        mkdir -p .ax-local/bin/linux_arm64
        go build -o .ax-local/bin/ate-local ./cmd/ate-local
        go build -o .ax-local/bin/ax-server ./cmd/ax-server
        go build -o .ax-local/bin/ax ./cmd/ax
        GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
          go build -trimpath -ldflags="-s -w" -o .ax-local/bin/linux_arm64/ax-task-runner ./cmd/ax-task-runner
      )
      ;;
    ax-experiments)
      if [[ ! -d "$AX_EXPERIMENTS_REPO/.git" ]]; then
        echo "==> Cloning ghchinoy/ax-experiments into $AX_EXPERIMENTS_REPO..."
        git clone https://github.com/ghchinoy/ax-experiments.git "$AX_EXPERIMENTS_REPO"
      fi
      ;;
    agent-image)
      echo "==> Building arm64 ax-agent-local:latest image with Apple container..."
      container build -t ax-agent-local:latest "$AX_EXPERIMENTS_REPO/swarm/agent-image"
      ;;
    all)
      if ! command -v wails >/dev/null 2>&1 && [[ ! -x "$HOME/go/bin/wails" ]]; then
        install_target wails || true
      elif [[ "$(uname -s)" == "Linux" ]] && ( ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists gtk+-3.0 || ( ! pkg-config --exists webkit2gtk-4.1 && ! pkg-config --exists webkit2gtk-4.0 ) ); then
        install_target wails || true
      fi
      if command -v container >/dev/null 2>&1 && ! container list >/dev/null 2>&1; then
        install_target container-daemon || true
      fi
      if [[ ! -f "$AX_REPO/examples/ate_local/local-stack.sh" ]]; then
        install_target ax-repo
      fi
      if [[ -f "$AX_REPO/examples/ate_local/local-stack.sh" && ! -x "$AX_REPO/.ax-local/bin/linux_arm64/ax-task-runner" ]]; then
        install_target ate-local-bins
      fi
      if [[ ! -d "$AX_EXPERIMENTS_REPO/swarm" ]]; then
        install_target ax-experiments
      fi
      if command -v container >/dev/null 2>&1 && container list >/dev/null 2>&1 && [[ -d "$AX_EXPERIMENTS_REPO/swarm/agent-image" ]]; then
        if ! container image list 2>/dev/null | grep -q "ax-agent-local"; then
          install_target agent-image || true
        fi
      fi
      ;;
    *)
      echo "Unknown install target: $target" >&2
      exit 1
      ;;
  esac
}

if [[ "$MODE" == "install" ]]; then
  install_target "$INSTALL_TARGET"
  MODE="human"
fi

CHECKS_JSON=""
append_check() {
  local id="$1" tier="$2" title="$3" status="$4" detail="$5" fix="$6"
  if [[ "$MODE" == "json" ]]; then
    local item
    item=$(printf '{"id":"%s","tier":"%s","title":"%s","status":"%s","detail":"%s","fix":"%s"}' \
      "$(json_escape "$id")" \
      "$(json_escape "$tier")" \
      "$(json_escape "$title")" \
      "$(json_escape "$status")" \
      "$(json_escape "$detail")" \
      "$(json_escape "$fix")")
    if [[ -z "$CHECKS_JSON" ]]; then
      CHECKS_JSON="$item"
    else
      CHECKS_JSON="$CHECKS_JSON,$item"
    fi
  else
    local sym="✓"
    [[ "$status" == "warn" ]] && sym="!"
    [[ "$status" == "fail" ]] && sym="✗"
    printf '  [%s] %-32s %s\n' "$sym" "$title" "$detail"
    if [[ "$status" != "ok" && -n "$fix" ]]; then
      printf '      fix: %s\n' "$fix"
    fi
  fi
}

OS_NAME="$(uname -s)"

# 1. Go toolchain & Wails CLI
if GO_BIN="$(command -v go 2>/dev/null)"; then
  GO_VER="$(go version 2>/dev/null | awk '{print $3}')"
  WAILS_BIN="$(command -v wails 2>/dev/null || ( [[ -x "$HOME/go/bin/wails" ]] && echo "$HOME/go/bin/wails" ) || true)"
  if [[ -z "$WAILS_BIN" ]]; then
    append_check "go" "core" "Go & Wails toolchain" "warn" "${GO_VER} (${GO_BIN}); wails CLI not installed" "hack/doctor.sh --install wails"
  elif [[ "$OS_NAME" == "Linux" ]] && ( ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists gtk+-3.0 || ( ! pkg-config --exists webkit2gtk-4.1 && ! pkg-config --exists webkit2gtk-4.0 ) ); then
    append_check "go" "core" "Go & Wails toolchain" "warn" "${GO_VER} + wails (${WAILS_BIN}); missing GTK3/WebKit2GTK dev libs" "hack/doctor.sh --install wails"
  else
    append_check "go" "core" "Go & Wails toolchain" "ok" "${GO_VER} + wails (${WAILS_BIN})" ""
  fi
else
  append_check "go" "core" "Go & Wails toolchain" "fail" "go not found on PATH" "brew install go"
fi

# 2. Apple container CLI & daemon
if CONTAINER_BIN="$(command -v container 2>/dev/null)"; then
  if container list >/dev/null 2>&1; then
    append_check "apple-container" "ate-local" "Apple container runtime" "ok" "${CONTAINER_BIN} (daemon running)" ""
  else
    append_check "apple-container" "ate-local" "Apple container runtime" "warn" "${CONTAINER_BIN} installed, daemon stopped" "container system start"
  fi
elif [[ "$OS_NAME" == "Linux" ]]; then
  append_check "apple-container" "ate-local" "Apple container runtime" "ok" "macOS-only (Linux/Crostini uses Kind + gVisor)" ""
else
  append_check "apple-container" "ate-local" "Apple container runtime" "warn" "/usr/local/bin/container not found" "brew install --cask container && container system start"
fi

# 3. AX repository & ate-local / Kind variant
if [[ -d "$AX_REPO" ]]; then
  BRANCH="$(git -C "$AX_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
  if [[ -f "$AX_REPO/examples/ate_local/local-stack.sh" && -d "$AX_REPO/cmd/ate-local" ]]; then
    append_check "ax-repo-variant" "ate-local" "AX repo (ate-local variant)" "ok" "${AX_REPO} (branch: ${BRANCH})" ""
  elif [[ "$OS_NAME" == "Linux" && -f "$AX_REPO/hack/setup-e2e-kind.sh" ]]; then
    append_check "ax-repo-variant" "ate-local" "AX repo (Kind / Crostini)" "ok" "${AX_REPO} (branch: ${BRANCH}, setup-e2e-kind.sh ready)" ""
  else
    append_check "ax-repo-variant" "ate-local" "AX repo (ate-local variant)" "warn" "${AX_REPO} missing cmd/ate-local (needs feat/ate-local-apple-container)" "hack/doctor.sh --install ax-repo"
  fi
else
  append_check "ax-repo-variant" "ate-local" "AX repo (ate-local variant)" "fail" "${AX_REPO} not found" "hack/doctor.sh --install ax-repo"
fi

# 4. Built ate-local / Kind binaries
if [[ -x "$AX_REPO/.ax-local/bin/ax" && -x "$AX_REPO/.ax-local/bin/ate-local" && -x "$AX_REPO/.ax-local/bin/ax-server" && -x "$AX_REPO/.ax-local/bin/linux_arm64/ax-task-runner" ]]; then
  append_check "ate-local-bins" "ate-local" "ate-local & arm64 task runner" "ok" "${AX_REPO}/.ax-local/bin ready" ""
elif [[ "$OS_NAME" == "Linux" && ( -x "$AX_REPO/.tmp/bin/ax" || -x "$AX_REPO/bin/ax" ) ]]; then
  append_check "ate-local-bins" "ate-local" "ax CLI & task runner" "ok" "${AX_REPO}/.tmp/bin/ax (or bin/ax) ready" ""
else
  if AX_ON_PATH="$(command -v ax 2>/dev/null)"; then
    append_check "ate-local-bins" "ate-local" "ate-local & arm64 task runner" "warn" "ax on PATH (${AX_ON_PATH}), .ax-local/bin not built yet" "hack/doctor.sh --install ate-local-bins"
  else
    append_check "ate-local-bins" "ate-local" "ate-local & arm64 task runner" "warn" ".ax-local/bin/{ax,ate-local,ax-server} not built yet" "hack/doctor.sh --install ate-local-bins"
  fi
fi

# 5. AX Experiments repo & ax-agent-local:latest / Crostini track
if [[ -d "$AX_EXPERIMENTS_REPO/swarm" && -d "$AX_EXPERIMENTS_REPO/genkit" ]]; then
  if command -v container >/dev/null 2>&1 && container image list 2>/dev/null | grep -q "ax-agent-local"; then
    append_check "ax-experiments" "ate-local" "ax-experiments & agent image" "ok" "${AX_EXPERIMENTS_REPO} + ax-agent-local:latest" ""
  elif [[ "$OS_NAME" == "Linux" && -f "$AX_EXPERIMENTS_REPO/crostini/setup-crostini.sh" ]]; then
    append_check "ax-experiments" "ate-local" "ax-experiments & Crostini track" "ok" "${AX_EXPERIMENTS_REPO}/crostini ready" ""
  else
    append_check "ax-experiments" "ate-local" "ax-experiments & agent image" "warn" "${AX_EXPERIMENTS_REPO} present; ax-agent-local:latest image not built" "hack/doctor.sh --install agent-image"
  fi
else
  append_check "ax-experiments" "ate-local" "ax-experiments & agent image" "warn" "${AX_EXPERIMENTS_REPO} not found" "hack/doctor.sh --install ax-experiments"
fi

# 6. Tier B: Kind + kubectl + Docker/Podman
K8S_DETAIL=""
K8S_STATUS="ok"
K8S_FIX=""
if ! command -v kind >/dev/null 2>&1 || ! command -v kubectl >/dev/null 2>&1; then
  K8S_STATUS="warn"
  K8S_DETAIL="kind or kubectl missing"
  K8S_FIX="brew install kind kubectl"
elif command -v docker >/dev/null 2>&1; then
  K8S_DETAIL="kind + kubectl + docker"
elif command -v podman >/dev/null 2>&1; then
  MEM="$(podman machine inspect --format '{{.Resources.Memory}}' 2>/dev/null || echo "0")"
  if [[ "${MEM:-0}" -gt 0 && "${MEM:-0}" -lt 6144 ]]; then
    K8S_STATUS="warn"
    K8S_DETAIL="kind + kubectl + podman (${MEM} MiB < 6144 MiB needed for Substrate)"
    K8S_FIX="podman machine stop && podman machine set --memory 8192 && podman machine start"
  else
    K8S_DETAIL="kind + kubectl + podman (with docker-shim.sh)"
  fi
else
  K8S_STATUS="warn"
  K8S_DETAIL="neither docker nor podman found"
  K8S_FIX="brew install podman"
fi
append_check "kind-stack" "kind" "Kind & container engine" "$K8S_STATUS" "$K8S_DETAIL" "$K8S_FIX"

if [[ "$MODE" == "json" ]]; then
  printf '{"axRepo":"%s","experimentsRepo":"%s","checks":[%s]}\n' \
    "$(json_escape "$AX_REPO")" \
    "$(json_escape "$AX_EXPERIMENTS_REPO")" \
    "$CHECKS_JSON"
fi
