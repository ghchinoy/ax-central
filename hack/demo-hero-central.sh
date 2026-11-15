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

# hack/demo-hero-central.sh runs the 5-step AX v0.1 Hero Demo against the live
# dual-cluster ate-local stack (:8090 / :8091) so every Workspace, warm Tag
# snapshot, Genkit A2A session turn, stock python:3.12-slim unittest run, and
# Cluster A -> Cluster B promotion appears live inside AX Central.app.
#
# Usage:
#   bash hack/demo-hero-central.sh [--reset] [--reset-only] [--interactive] [--cleanup] [--step <1-5>]

set -euo pipefail

AX_REPO="${AX_REPO:-$HOME/projects/ax}"
AX_REPO="${AX_REPO/#\~/$HOME}"
AX_EXPERIMENTS_REPO="${AX_EXPERIMENTS_REPO:-$HOME/projects/ax-experiments}"
AX_EXPERIMENTS_REPO="${AX_EXPERIMENTS_REPO/#\~/$HOME}"
AX_CENTRAL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RUN_LIVE="${AX_EXPERIMENTS_REPO}/hero-demo/run-live.sh"
STACK_SCRIPT="${AX_REPO}/examples/ate_local/local-stack.sh"

INTERACTIVE=0
CLEANUP=0
RESET=0
RESET_ONLY=0
ONLY_STEP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interactive|-i)
      INTERACTIVE=1
      shift
      ;;
    --cleanup)
      CLEANUP=1
      shift
      ;;
    --reset)
      RESET=1
      shift
      ;;
    --reset-only)
      RESET=1
      RESET_ONLY=1
      shift
      ;;
    --step)
      ONLY_STEP="${2:-}"
      shift 2
      ;;
    -h|--help)
      sed -n '16,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "${RESET}" == "1" ]]; then
  if [[ ! -x "${STACK_SCRIPT}" ]]; then
    echo "error: ${STACK_SCRIPT} not found" >&2
    exit 1
  fi
  echo "==> Resetting local AX stack, clearing .ax-local/snapshots/*, and starting dual-cluster multi-up..."
  bash "${STACK_SCRIPT}" reset
  rm -rf "${AX_REPO}/.ax-local/snapshots/"*
  make -C "${AX_REPO}" local-multi-up
  if [[ "${RESET_ONLY}" == "1" ]]; then
    echo "==> Fresh slate ready (:8090 Apple container + :8091 Podman). Open AX Central (⌘5) and hit Record!"
    exit 0
  fi
fi

if [[ ! -f "${RUN_LIVE}" ]]; then
  echo "error: ${RUN_LIVE} not found (ensure ~/projects/ax-experiments is up to date)" >&2
  exit 1
fi

pause_step() {
  local prompt="$1"
  if [[ "${INTERACTIVE}" == "1" ]]; then
    echo ""
    read -r -p "  [AX Central Presenter] ${prompt} — press Enter to continue... " _
  fi
}

KEEP_ARGS=(--attach)
if [[ "${CLEANUP}" == "0" ]]; then
  KEEP_ARGS+=(--keep-stack)
fi

if [[ -n "${ONLY_STEP}" ]]; then
  AX_REPO="${AX_REPO}" AX_CENTRAL_REPO="${AX_CENTRAL_REPO}" \
    bash "${RUN_LIVE}" "${KEEP_ARGS[@]}" --step "${ONLY_STEP}"
  exit 0
fi

if [[ "${INTERACTIVE}" == "0" ]]; then
  echo "==> Running all 5 AX v0.1 Hero Demo steps live against AX Central (:8090 / :8091)..."
  AX_REPO="${AX_REPO}" AX_CENTRAL_REPO="${AX_CENTRAL_REPO}" \
    bash "${RUN_LIVE}" "${KEEP_ARGS[@]}"
  exit 0
fi

echo "================================================================================"
echo "  AX Central · Interactive 5/5 Hero Demo Presenter Walkthrough"
echo "================================================================================"

pause_step "Open Clusters (⌘5) in AX Central to watch Cluster A (:8090) & Cluster B (:8091) boot"
AX_REPO="${AX_REPO}" AX_CENTRAL_REPO="${AX_CENTRAL_REPO}" bash "${RUN_LIVE}" --attach --keep-stack --step 1

pause_step "Switch to Activity (⌘1) to watch hero-demo-ws & warm snapshot archive appear"
AX_REPO="${AX_REPO}" AX_CENTRAL_REPO="${AX_CENTRAL_REPO}" bash "${RUN_LIVE}" --attach --keep-stack --step 2

pause_step "Watch hero-demo-starter-task run Session Turn 1, suspend/resume, and Turn 2 (inspect OTel & A2A Console)"
AX_REPO="${AX_REPO}" AX_CENTRAL_REPO="${AX_CENTRAL_REPO}" bash "${RUN_LIVE}" --attach --keep-stack --step 3

pause_step "Watch stock python:3.12-slim (hero-demo-custom-task) skip git setup & pass 2/2 unit tests in Guest Logs"
AX_REPO="${AX_REPO}" AX_CENTRAL_REPO="${AX_CENTRAL_REPO}" bash "${RUN_LIVE}" --attach --keep-stack --step 4

pause_step "Switch Context to local-podman (:8091) or open Map (⌘2) to watch Cluster B promotion"
AX_REPO="${AX_REPO}" AX_CENTRAL_REPO="${AX_CENTRAL_REPO}" bash "${RUN_LIVE}" "${KEEP_ARGS[@]}" --step 5

if [[ "${CLEANUP}" == "1" && -x "${STACK_SCRIPT}" ]]; then
  bash "${STACK_SCRIPT}" down
fi
