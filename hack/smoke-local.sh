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

# hack/smoke-local.sh runs a zero-credential E2E smoke test of a plain
# debian:12 task on the local macOS Apple container stack (ate-local).

set -euo pipefail

AX_REPO="${AX_REPO:-$HOME/projects/ax}"
AX_REPO="${AX_REPO/#\~/$HOME}"
STACK_SCRIPT="${AX_REPO}/examples/ate_local/local-stack.sh"
AX_BIN="${AX_REPO}/.ax-local/bin/ax"
SERVER_ADDR="${AX_SERVER:-localhost:8090}"

if [[ ! -f "$STACK_SCRIPT" ]]; then
  echo "skip: $STACK_SCRIPT not found"
  exit 0
fi

if ! command -v container >/dev/null 2>&1 || ! container list >/dev/null 2>&1; then
  echo "skip: Apple container daemon is not running"
  exit 0
fi

if ! nc -z 127.0.0.1 8090 >/dev/null 2>&1; then
  echo "==> Starting local Apple container stack..."
  bash "$STACK_SCRIPT" up
fi

TASK_NAME="smoke-debian-$(date +%s)"
cleanup() {
  "$AX_BIN" --server "$SERVER_ADDR" -a default delete task "$TASK_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Applying plain debian:12 task ($TASK_NAME)..."
cat <<EOF | "$AX_BIN" --server "$SERVER_ADDR" -a default apply -f -
apiVersion: ax.io/v1alpha1
kind: Task
metadata:
  name: "${TASK_NAME}"
spec:
  image: "debian:12"
  command: ["sh", "-c", "echo smoke-ready && sleep 120"]
  resources:
    limits:
      cpu: "1"
      memory: "512Mi"
  debug: true
EOF

echo "==> Resuming $TASK_NAME..."
"$AX_BIN" --server "$SERVER_ADDR" -a default resume task "$TASK_NAME" || "$AX_BIN" --server "$SERVER_ADDR" -a default resume "$TASK_NAME"

echo "==> Running ax ssh uname -sm..."
OUT="$("$AX_BIN" --server "$SERVER_ADDR" -a default ssh "$TASK_NAME" -- uname -sm)"
echo "    output: $OUT"
[[ "$OUT" == *"Linux"* ]] || { echo "unexpected ssh output: $OUT" >&2; exit 1; }
echo "==> Smoke test passed!"
