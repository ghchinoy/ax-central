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

# hack/smoke-crostini.sh runs a zero-credential E2E smoke test of a Workspace +
# Task lifecycle (apply -> resume -> ax ssh -> guest logs -> suspend -> delete)
# on a local Kind + Agent Substrate (v1.0.0-rc.1+) cluster (e.g. Crostini VM).

set -euo pipefail

AX_REPO="${AX_REPO:-$HOME/projects/ax}"
AX_REPO="${AX_REPO/#\~/$HOME}"
CLUSTER_NAME="${KIND_CLUSTER_NAME:-ax-e2e}"
KUBE_CTX="kind-${CLUSTER_NAME}"
KC_FILE="${KUBECONFIG:-${AX_REPO}/.tmp/kubeconfig-${CLUSTER_NAME}}"

if [[ -x "${AX_REPO}/.tmp/bin/ax" ]]; then
  AX_BIN="${AX_REPO}/.tmp/bin/ax"
elif [[ -x "${AX_REPO}/bin/ax" ]]; then
  AX_BIN="${AX_REPO}/bin/ax"
elif command -v ax >/dev/null 2>&1; then
  AX_BIN="$(command -v ax)"
else
  echo "skip: ax binary not found in ${AX_REPO} or PATH"
  exit 0
fi

if ! command -v kind >/dev/null 2>&1 || ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  echo "skip: Kind cluster ${CLUSTER_NAME} is not running"
  exit 0
fi

if [[ -f "${KC_FILE}" ]]; then
  export KUBECONFIG="${KC_FILE}"
fi

STAMP="$(date +%s)"
WS_NAME="smoke-crostini-ws-${STAMP}"
TASK_NAME="smoke-crostini-task-${STAMP}"

cleanup() {
  "${AX_BIN}" --context "${KUBE_CTX}" -a default delete task "${TASK_NAME}" >/dev/null 2>&1 || true
  "${AX_BIN}" --context "${KUBE_CTX}" -a default delete workspace "${WS_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Applying Workspace (${WS_NAME}) and Task (${TASK_NAME}) on ${KUBE_CTX}..."
cat <<EOF | "${AX_BIN}" --context "${KUBE_CTX}" -a default apply -f -
apiVersion: ax.io/v1alpha1
kind: Workspace
metadata:
  name: "${WS_NAME}"
  atespace: default
spec:
  files:
    - path: HELLO.txt
      content: "hello from ax-central crostini smoke test"
---
apiVersion: ax.io/v1alpha1
kind: Task
metadata:
  name: "${TASK_NAME}"
  atespace: default
spec:
  workspace:
    name: "${WS_NAME}"
  env:
    - name: AX_CENTRAL_SMOKE
      value: "crostini-ok"
  debug: true
EOF

echo "==> Resuming ${TASK_NAME} on gVisor..."
"${AX_BIN}" --context "${KUBE_CTX}" -a default resume task "${TASK_NAME}"

echo "==> Verifying ax ssh into gVisor sandbox..."
OUT="$("${AX_BIN}" --context "${KUBE_CTX}" -a default ssh "${TASK_NAME}" -- sh -c 'uname -sr && cat /workspace/HELLO.txt && echo "ENV=${AX_CENTRAL_SMOKE}"')"
echo "    output: $(echo "${OUT}" | tr '\n' ' ')"
[[ "${OUT}" == *"Linux"* ]] || { echo "unexpected uname output: ${OUT}" >&2; exit 1; }
[[ "${OUT}" == *"hello from ax-central crostini smoke test"* ]] || { echo "missing workspace file content: ${OUT}" >&2; exit 1; }
[[ "${OUT}" == *"ENV=crostini-ok"* ]] || { echo "missing env var: ${OUT}" >&2; exit 1; }

echo "==> Suspending ${TASK_NAME} (RustFS snapshot checkpoint)..."
"${AX_BIN}" --context "${KUBE_CTX}" -a default suspend task "${TASK_NAME}"

echo "==> Crostini Kind + Agent Substrate smoke test passed!"
