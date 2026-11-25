/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Stdin-piped Kubernetes Gateway Credential Secret management, adopted from
 * github.com/agentexecutor/studio (internal/studio/secrets.go & env.go):
 *
 * - Values are sent exclusively over kubectl stdin as a v1/Secret JSON
 *   manifest labeled `ax.io/credential: "true"` — never in process argv,
 *   temp files, or activity logs.
 * - Status probes read only secret key names via a Go template, so secret
 *   values never leave the cluster.
 */

import { ensureStudioBridge } from "../bridge";
import { isLocalContext, isSafeResourceName, validateLabel } from "./resources";
import { store } from "./store";

export const DEFAULT_SECRET_NAMESPACE = "ax-system";
export const SECRET_KEY_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Go template that prints "found" on line 1 followed by each key name in
 * `.data`, one per line. Never prints secret values.
 */
export const SECRET_KEYS_TEMPLATE =
  'found{{"\\n"}}{{range $k, $v := .data}}{{$k}}{{"\\n"}}{{end}}';

export interface CredentialSecretStatus {
  context: string;
  namespace: string;
  name: string;
  key: string;
  exists: boolean;
  hasKey: boolean;
  keys: string[];
  credentialUri: string;
  isLocal?: boolean;
  error?: string;
}

export interface CredentialSecretInput {
  context?: string;
  namespace?: string;
  name: string;
  key: string;
  value?: string;
}

export function credentialSecretURI(
  namespace: string,
  name: string,
  key: string,
): string {
  return `ate-secret://k8s.io/default/${namespace}/${name}/${key}`;
}

/** Validates secret name, namespace, key, context, and optional value. */
export function validateCredentialSecretInput(
  input: CredentialSecretInput,
  requireValue = false,
): string | null {
  const nameErr = validateLabel(input.name.trim());
  if (nameErr) return `Invalid secret name: ${nameErr}`;
  const ns = (input.namespace ?? DEFAULT_SECRET_NAMESPACE).trim();
  const nsErr = validateLabel(ns);
  if (nsErr) return `Invalid namespace: ${nsErr}`;
  const key = input.key.trim();
  if (!key || !SECRET_KEY_RE.test(key)) {
    return "Invalid secret key (use letters, digits, '.', '_', or '-')";
  }
  const ctx = (input.context ?? "").trim();
  if (ctx && (!isSafeResourceName(ctx) || ctx.startsWith("-"))) {
    return `Invalid context "${ctx}"`;
  }
  if (requireValue && !input.value) {
    return "Secret value is required";
  }
  return null;
}

function encodeUTF8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/**
 * Renders a Kubernetes v1/Secret JSON manifest labeled `ax.io/credential=true`
 * suitable for piping directly to `kubectl apply -f -`.
 */
export function buildCredentialSecretJSON(opts: {
  namespace: string;
  name: string;
  key: string;
  value: string;
}): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: opts.name.trim(),
      namespace: opts.namespace.trim(),
      labels: {
        "ax.io/credential": "true",
      },
    },
    data: {
      [opts.key.trim()]: encodeUTF8Base64(opts.value),
    },
  });
}

/** Parses stdout from `kubectl get secret -o go-template=SECRET_KEYS_TEMPLATE`. */
export function parseSecretKeysOutput(
  stdout: string,
  wantedKey: string,
): { exists: boolean; hasKey: boolean; keys: string[] } {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines[0] !== "found") {
    return { exists: false, hasKey: false, keys: [] };
  }
  const keys = lines.slice(1);
  return {
    exists: true,
    hasKey: keys.includes(wantedKey.trim()),
    keys,
  };
}

function kubectlContextEnv(context: string): Record<string, string> {
  const kc = store.state.kindKubeconfigs[context];
  return kc ? { KUBECONFIG: kc } : {};
}

/**
 * Checks whether a Gateway credential Secret exists in the target cluster and
 * contains `key`. Reads key names only — values never leave the cluster.
 */
export async function probeCredentialSecret(
  input: CredentialSecretInput,
): Promise<CredentialSecretStatus> {
  ensureStudioBridge();
  const context = (input.context ?? store.state.context).trim();
  const namespace = (input.namespace || DEFAULT_SECRET_NAMESPACE).trim();
  const name = input.name.trim();
  const key = input.key.trim();
  const uri = credentialSecretURI(namespace, name, key);

  if (isLocalContext(context)) {
    return {
      context,
      namespace,
      name,
      key,
      exists: false,
      hasKey: false,
      keys: [],
      credentialUri: uri,
      isLocal: true,
    };
  }

  const problem = validateCredentialSecretInput(
    { context, namespace, name, key },
    false,
  );
  if (problem) {
    return {
      context,
      namespace,
      name,
      key,
      exists: false,
      hasKey: false,
      keys: [],
      credentialUri: uri,
      error: problem,
    };
  }

  const args: string[] = [];
  if (context) args.push("--context", context);
  args.push(
    "-n",
    namespace,
    "get",
    "secret",
    name,
    "--ignore-not-found",
    "-o",
    `go-template=${SECRET_KEYS_TEMPLATE}`,
  );
  const res = await window.studio.run({
    program: "kubectl",
    args,
    env: kubectlContextEnv(context),
  });
  if (res.status !== 0) {
    const errLine =
      res.stderr.trim().split("\n").pop()?.trim() ||
      "Could not read Secret from cluster";
    return {
      context,
      namespace,
      name,
      key,
      exists: false,
      hasKey: false,
      keys: [],
      credentialUri: uri,
      error: errLine,
    };
  }
  const parsed = parseSecretKeysOutput(res.stdout, key);
  return {
    context,
    namespace,
    name,
    key,
    ...parsed,
    credentialUri: uri,
  };
}

/**
 * Creates or updates a Kubernetes Gateway credential Secret labeled
 * `ax.io/credential=true` by piping its JSON manifest to `kubectl apply -f -`
 * via stdin. The secret value never appears in argv, disk files, or logs.
 */
export async function saveCredentialSecret(
  input: CredentialSecretInput,
): Promise<{
  ok: boolean;
  error?: string;
  status?: CredentialSecretStatus;
}> {
  ensureStudioBridge();
  const context = (input.context ?? store.state.context).trim();
  const namespace = (input.namespace || DEFAULT_SECRET_NAMESPACE).trim();
  const name = input.name.trim();
  const key = input.key.trim();

  if (isLocalContext(context)) {
    return {
      ok: false,
      error:
        "Switch to a Kubernetes context (Kind, GKE, OrbStack, Crostini) to store a Gateway credential Secret.",
    };
  }
  const problem = validateCredentialSecretInput(
    { context, namespace, name, key, value: input.value },
    true,
  );
  if (problem) return { ok: false, error: problem };

  const manifestJSON = buildCredentialSecretJSON({
    namespace,
    name,
    key,
    value: input.value!,
  });
  const args: string[] = [];
  if (context) args.push("--context", context);
  args.push("-n", namespace, "apply", "-f", "-");

  const res = await window.studio.run({
    program: "kubectl",
    args,
    stdin: manifestJSON,
    env: kubectlContextEnv(context),
  });
  if (res.status !== 0) {
    const errLine =
      res.stderr.trim().split("\n").pop()?.trim() ||
      "Failed to apply credential Secret";
    return { ok: false, error: errLine };
  }
  const status = await probeCredentialSecret({ context, namespace, name, key });
  return { ok: true, status };
}
