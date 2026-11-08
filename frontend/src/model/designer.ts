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

import { ensureStudioBridge } from "../bridge";
import { validateImage, validateLabel } from "./resources";

export type WorkspaceMode = "none" | "existing" | "new";
export type ConfigMode = "none" | "custom";
export type Template =
  | "blank"
  | "simple"
  | "ate-local"
  | "genkit-apple-container"
  | "swarm-reviewer"
  | "antigravity"
  | "gemini"
  | "openai"
  | "claude-managed-agents"
  | "github-actions";

export interface KeyValue {
  id: number;
  key: string;
  value: string;
}
export interface RepoDraft {
  id: number;
  name: string;
  repo: string;
  branch: string;
}
export interface FileDraft {
  id: number;
  path: string;
  content: string;
}
export interface ServerDraft {
  id: number;
  name: string;
  endpoint: string;
  command?: string;
  args?: string[];
}

export interface Draft {
  name: string;
  atespace: string;
  image: string;
  command: string;
  env: KeyValue[];
  cpu: number;
  memoryMi: number;
  debug: boolean;
  configMode: ConfigMode;
  customConfig: string;
  workspaceMode: WorkspaceMode;
  existingWorkspace: string;
  wsName: string;
  repos: RepoDraft[];
  files: FileDraft[];
  servers: ServerDraft[];
  skillsPath?: string;
  includeModel: boolean;
  modelName: string;
  provider: string;
  modelID: string;
  secretName: string;
  secretKey: string;
  maxTokens: number;
  rawMode: boolean;
  rawYAML: string;
  filePath: string | null;
}

let nextID = 1;
export const uid = () => nextID++;

export const hexID = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export const withID = (name: string) =>
  `${name.replace(/-[0-9a-f]{8}$/, "")}-${hexID()}`;

export const TEMPLATES: { id: Template; title: string; group?: string }[] = [
  { id: "blank", title: "Blank" },
  { id: "simple", title: "Shell" },
  {
    id: "ate-local",
    title: "Apple Container Task (ate-local)",
    group: "ax-experiments",
  },
  {
    id: "genkit-apple-container",
    title: "Genkit Incident Triage (ate-local)",
    group: "ax-experiments",
  },
  {
    id: "swarm-reviewer",
    title: "Swarm Code Reviewer (ate-local)",
    group: "ax-experiments",
  },
  { id: "antigravity", title: "Antigravity Agent", group: "ax-images" },
  { id: "gemini", title: "Gemini Agent", group: "ax-images" },
  { id: "openai", title: "OpenAI Agent", group: "ax-images" },
  { id: "claude-managed-agents", title: "Claude Agent", group: "ax-images" },
  {
    id: "github-actions",
    title: "GitHub Actions Runner",
    group: "ax-images",
  },
];

function blank(): Draft {
  return {
    name: "my-task",
    atespace: "",
    image: "",
    command: "",
    env: [],
    cpu: 1,
    memoryMi: 512,
    debug: true,
    configMode: "none",
    customConfig: "key: value\n",
    workspaceMode: "none",
    existingWorkspace: "",
    wsName: "my-workspace",
    repos: [],
    files: [],
    servers: [],
    includeModel: false,
    modelName: "default-model",
    provider: "anthropic",
    modelID: "claude-opus-5-5",
    secretName: "anthropic-api-secret",
    secretKey: "ANTHROPIC_API_KEY",
    maxTokens: 16000,
    rawMode: false,
    rawYAML: "",
    filePath: null,
  };
}

const AX_IMAGES = "ghcr.io/rakyll/ax-images";
const IMAGE_DIGESTS = {
  antigravity:
    "sha256:8025a987861673718564e0e648a3c7785d23c2514be8c7a3d3b133413d9bc81e",
  gemini:
    "sha256:e3d8d953fc1ca112e3b0d00a655d82008996a328a5e8dbd1777f68f492fb91bc",
  openai:
    "sha256:9eeeb86183c1514ca4e3da8f412c2f704a457be13ba9797ebb1d942ba89417c1",
  "claude-managed-agents":
    "sha256:1a532d86c58a5fea3005e9c525683cf8f354e2c403be6460a308ad2f8f0510c0",
  "github-actions":
    "sha256:63d02f8ff154efd5ee269414bc793bde90afb5aadedbe756e1c2f8389207c7bd",
};
const image = (name: keyof typeof IMAGE_DIGESTS) =>
  `${AX_IMAGES}/${name}@${IMAGE_DIGESTS[name]}`;

const AGENT_PROMPT = `prompt: |
  Read the repository, install it with its test dependencies, and run the
  test suite. Fix any failing or flaky tests you find. If everything passes,
  make one small, clearly correct improvement to the README. Finish by
  writing a short markdown report of what you checked and what you changed
  to /workspace/agent-output.md.
`;

function agentTask(
  d: Draft,
  name: keyof typeof IMAGE_DIGESTS,
  config: string,
  secrets: string[],
): Draft {
  return {
    ...d,
    name,
    image: image(name),
    cpu: 2,
    memoryMi: 4096,
    configMode: "custom",
    customConfig: config,
    env: secrets.map((key) => ({ id: uid(), key, value: "" })),
    workspaceMode: "new",
    wsName: `cachetools-${name}`,
    repos: [
      {
        id: uid(),
        name: "origin",
        repo: "https://github.com/tkem/cachetools.git",
        branch: "master",
      },
    ],
    files: [
      {
        id: uid(),
        path: "AGENTS.md",
        content: `# Working in this repo
- Pure-Python library. Install with \`pip install -e . pytest\`, test with \`pytest\`.
- Keep changes small and focused; do not add runtime dependencies.
- Do not push or open pull requests. Leave changes in the working tree.
`,
      },
    ],
  };
}

export function template(t: Template): Draft {
  const d = templateDraft(t);
  return { ...d, name: withID(d.name) };
}

function templateDraft(t: Template): Draft {
  const d = blank();
  switch (t) {
    case "blank":
      return d;
    case "simple":
      return {
        ...d,
        name: "shell-task",
        command: "sh -c 'echo $ENVIRONMENT'",
        env: [{ id: uid(), key: "ENVIRONMENT", value: "test" }],
      };
    case "ate-local":
      return {
        ...d,
        name: "local-task",
        image: "debian:12",
        command: "sh -c 'uname -sm && sleep 300'",
        env: [{ id: uid(), key: "ENVIRONMENT", value: "local" }],
        cpu: 2,
        memoryMi: 1024,
        debug: true,
      };
    case "genkit-apple-container":
      return {
        ...d,
        name: "genkit-triage",
        image: "ax-agent-local:latest",
        cpu: 2,
        memoryMi: 2048,
        debug: true,
        configMode: "custom",
        customConfig: `name: triage_agent
description: Triages failing tests and writes reports to the workspace.
model: googleai/gemini-3.8-flash
instruction: |
  You are a careful Go engineer triaging a repository in your workspace.
  Always use the filesystem tools (list_files, read_file, write_file,
  search_and_replace) and any available MCP telemetry tools to inspect
  files before answering or making changes. Keep your answers concise.
config:
  maxOutputTokens: 2048
  temperature: 0.2
maxTurns: 10
use:
  - name: genkit-middleware/filesystem
    config:
      rootDirectory: /workspace
      allowWriteAccess: true
  - name: genkit-middleware/skills
`,
        env: [{ id: uid(), key: "GEMINI_API_KEY", value: "" }],
        workspaceMode: "new",
        wsName: "demo-workspace",
        skillsPath: ".agents/skills",
        servers: [
          {
            id: uid(),
            name: "telemetry",
            endpoint: "",
            command: "python3",
            args: ["/workspace/tools/incident_mcp.py"],
          },
        ],
        files: [
          {
            id: uid(),
            path: "README.md",
            content: `# Payment Service (payd)
Handles checkout authorization and settlement retries.

## Known Issues
- \`TestRetryBackoff_ZeroJitter\` in \`retry_test.go\` fails intermittently when \`maxJitter == 0\` because \`rand.Int63n(0)\` panics.
- \`settlement.go\`: batch timeout is hardcoded to 5s instead of reading \`Config.BatchTimeout\`.
`,
          },
          {
            id: uid(),
            path: "retry_test.go",
            content: `package payd

import (
    "math/rand"
    "testing"
)

func ComputeJitter(maxJitter int64) int64 {
    // BUG: panics when maxJitter <= 0
    return rand.Int63n(maxJitter)
}

func TestRetryBackoff_ZeroJitter(t *testing.T) {
    got := ComputeJitter(0)
    if got != 0 {
        t.Fatalf("ComputeJitter(0) = %d, want 0", got)
    }
}
`,
          },
          {
            id: uid(),
            path: ".agents/skills/incident-runbook/SKILL.md",
            content: `---
name: incident-runbook
description: Standard operating procedure for triaging payd incidents and formatting triage reports.
---
# Payment Service (payd) Incident Runbook
1. Inspect \`README.md\` and the failing test file before editing any code.
2. Keep code fixes minimal and guard against zero or negative bounds.
3. Write a concise summary to \`TRIAGE_REPORT.md\`.
`,
          },
          {
            id: uid(),
            path: "tools/incident_mcp.py",
            content: `#!/usr/bin/env python3
"""Minimal zero-dependency stdio MCP server exposing incident telemetry."""
import json, sys
for line in sys.stdin:
    if not line.strip(): continue
    req = json.loads(line)
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": {}}) + "\\n")
    sys.stdout.flush()
`,
          },
        ],
      };
    case "swarm-reviewer":
      return {
        ...d,
        name: "panel-security-reviewer",
        image: "ax-agent-local:latest",
        cpu: 2,
        memoryMi: 2048,
        debug: true,
        configMode: "custom",
        customConfig: `role: Application Security Auditor
model: gemini-3.8-flash
prompt: |
  Audit the repository in /workspace for concurrency hazards, input validation
  issues, and subprocess handling. Write findings to /workspace/review.md.
`,
        env: [
          { id: uid(), key: "GEMINI_API_KEY", value: "" },
          {
            id: uid(),
            key: "AGENT_ROLE",
            value: "Application Security Auditor",
          },
          {
            id: uid(),
            key: "AGENT_PROMPT",
            value:
              "Audit /workspace for security and subprocess vulnerabilities.",
          },
        ],
        workspaceMode: "new",
        wsName: "swarm-workspace",
        repos: [
          {
            id: uid(),
            name: "origin",
            repo: "https://github.com/google/ax.git",
            branch: "main",
          },
        ],
      };
    case "antigravity":
      return agentTask(
        d,
        "antigravity",
        AGENT_PROMPT +
          `model: gemini-3.8-flash
maxTurns: 100
builtinTools: ["google_search", "url_context"]
`,
        ["GEMINI_API_KEY"],
      );
    case "gemini":
      return agentTask(
        d,
        "gemini",
        AGENT_PROMPT +
          `model: gemini-3.8-flash
maxTurns: 50
builtinTools: ["google_search", "url_context"]
`,
        ["GEMINI_API_KEY"],
      );
    case "openai":
      return agentTask(
        d,
        "openai",
        AGENT_PROMPT +
          `model: gpt-5.5
maxTurns: 50
builtinTools: ["web_search"]
`,
        ["OPENAI_API_KEY"],
      );
    case "claude-managed-agents":
      return agentTask(
        d,
        "claude-managed-agents",
        `environment: "env_..."
agent:
  model: "claude-opus-5-5"
  system: "You are a careful software engineer working in /workspace."
` + AGENT_PROMPT,
        ["ANTHROPIC_API_KEY", "ANTHROPIC_ENVIRONMENT_KEY"],
      );
    case "github-actions":
      return {
        ...d,
        name: "github-actions",
        image: image("github-actions"),
        cpu: 2,
        memoryMi: 4096,
        debug: false,
        configMode: "custom",
        customConfig: `repository: "<owner>/<repo>"
labels: ["self-hosted", "ax"]
jobs: 1
`,
        env: [{ id: uid(), key: "GITHUB_TOKEN", value: "" }],
      };
  }
}

// MARK: Validation

export interface Issue {
  severity: "error" | "warning";
  text: string;
}

export const isSecret = (key: string) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key);

export function validateEnvName(key: string, all: KeyValue[]): string | null {
  if (!key) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    return "letters, digits and _, not starting with a digit";
  if (all.filter((kv) => kv.key === key).length > 1)
    return "set more than once";
  return null;
}

export function parseEnv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = (eq < 0 ? line : line.slice(0, eq)).trim();
    let value = eq < 0 ? "" : line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value.endsWith(value[0])
    )
      value = value.slice(1, -1);
    out.push({ key, value });
  }
  return out;
}

export const formatEnv = (env: KeyValue[]) =>
  env.map((kv) => `${kv.key}=${kv.value}`).join("\n");

export function issues(d: Draft): Issue[] {
  if (d.rawMode) return [];
  const out: Issue[] = [];
  const err = (text: string) => out.push({ severity: "error", text });
  const warn = (text: string) => out.push({ severity: "warning", text });
  let e: string | null;
  if ((e = validateLabel(d.name))) err(`Task name: ${e}`);
  if (d.atespace && (e = validateLabel(d.atespace))) err(`Atespace: ${e}`);
  if ((e = validateImage(d.image))) warn(`Image: ${e}`);
  if (d.image.includes("REPLACE_WITH"))
    err("Image: replace the placeholder digest");
  if (d.workspaceMode === "new" && (e = validateLabel(d.wsName)))
    err(`Workspace name: ${e}`);
  if (d.workspaceMode === "existing" && !d.existingWorkspace)
    err("Pick a workspace to bind");
  if (d.workspaceMode === "new" && d.repos.some((r) => !r.repo))
    warn("A git repo has no URL");
  if (
    d.workspaceMode === "new" &&
    d.servers.some((s) => {
      const target = [s.command ?? "", ...(s.args ?? []), s.endpoint].join(" ");
      return (
        /(?:^|\s)(?:sh|bash|zsh|npx)\s+-c\b/.test(target) ||
        /[|;&`$]/.test(target)
      );
    })
  ) {
    warn(
      "MCP server: avoid shell wrappers (-c) or shell metacharacters in STDIO commands",
    );
  }
  if (d.includeModel && (e = validateLabel(d.modelName)))
    err(`Model name: ${e}`);
  if (d.env.some((kv) => !kv.key && kv.value)) warn("An env var has no name");
  if (d.env.some((kv) => validateEnvName(kv.key, d.env)))
    err("Environment: fix the highlighted names");
  if (d.env.some((kv) => isSecret(kv.key) && !kv.value))
    warn("A credential env var is empty");
  return out;
}

export const canApply = (d: Draft) =>
  !issues(d).some((i) => i.severity === "error");

// MARK: YAML

export const memoryString = (mi: number) =>
  mi >= 1024 && mi % 1024 === 0 ? `${mi / 1024}Gi` : `${Math.round(mi)}Mi`;
export const cpuString = (c: number) =>
  c < 1 ? `${Math.round(c * 1000)}m` : `${+c.toFixed(2)}`;

export const q = (s: string) =>
  '"' +
  s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t") +
  '"';

function block(s: string, indent: number) {
  if (!s.includes("\n")) return q(s);
  const pad = " ".repeat(indent);
  return (
    "|\n" +
    s
      .trimEnd()
      .split("\n")
      .map((l) => (l ? pad + l : ""))
      .join("\n")
  );
}

export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let any = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      any = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      any = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (any || cur) {
        out.push(cur);
        cur = "";
        any = false;
      }
      continue;
    }
    cur += ch;
  }
  if (any || cur) out.push(cur);
  return out;
}

export function generate(d: Draft, redact = false): string {
  if (d.rawMode) return d.rawYAML;
  const docs: string[] = [];
  const ates = d.atespace ? `\n  atespace: ${q(d.atespace)}` : "";

  if (d.includeModel) {
    let y = `apiVersion: ax.io/v1alpha1\nkind: Model\nmetadata:\n  name: ${q(d.modelName)}${ates}\nspec:\n  provider: ${q(d.provider)}\n  model: ${q(d.modelID)}\n  secretKey:\n    name: ${q(d.secretName)}\n    key: ${q(d.secretKey)}`;
    if (d.maxTokens > 0) y += `\n  parameters:\n    maxTokens: ${d.maxTokens}`;
    docs.push(y);
  }

  if (d.workspaceMode === "new") {
    let y = `apiVersion: ax.io/v1alpha1\nkind: Workspace\nmetadata:\n  name: ${q(d.wsName)}${ates}\nspec:`;
    let empty = true;
    if (d.repos.length) {
      empty = false;
      y += "\n  git:";
      for (const r of d.repos) {
        y += `\n    - name: ${q(r.name || "origin")}\n      repo: ${q(r.repo)}`;
        if (r.branch) y += `\n      branch: ${q(r.branch)}`;
      }
    }
    if (d.files.length) {
      empty = false;
      y += "\n  files:";
      for (const f of d.files)
        y += `\n    - path: ${q(f.path)}\n      content: ${block(f.content, 8)}`;
    }
    if (d.servers.length) {
      empty = false;
      y += "\n  mcp:\n    servers:";
      for (const s of d.servers) {
        y += `\n      - name: ${q(s.name)}`;
        if (s.command) {
          y += `\n        command: ${q(s.command)}`;
          if (s.args?.length) {
            y += `\n        args: [${s.args.map(q).join(", ")}]`;
          }
        } else {
          y += `\n        endpoint: ${q(s.endpoint)}`;
        }
      }
    }
    if (d.skillsPath) {
      empty = false;
      y += `\n  skills:\n    path: ${q(d.skillsPath)}`;
    }
    if (empty) y += " {}";
    docs.push(y);
  }

  let t = `apiVersion: ax.io/v1alpha1\nkind: Task\nmetadata:\n  name: ${q(d.name)}${ates}\nspec:`;
  if (d.image) t += `\n  image: ${q(d.image)}`;
  const argv = tokenize(d.command);
  if (argv.length) t += `\n  command: [${argv.map(q).join(", ")}]`;
  if (d.configMode === "custom") {
    t +=
      "\n  config:\n" +
      d.customConfig
        .split("\n")
        .map((l) => "    " + l)
        .join("\n")
        .trimEnd();
  }
  const env = d.env.filter((kv) => kv.key);
  if (env.length) {
    t += "\n  env:";
    for (const kv of env) {
      const v = redact && isSecret(kv.key) && kv.value ? "••••••••" : kv.value;
      t += `\n    - name: ${q(kv.key)}\n      value: ${q(v)}`;
    }
  }
  t += `\n  resources:\n    limits:\n      cpu: ${q(cpuString(d.cpu))}\n      memory: ${q(memoryString(d.memoryMi))}`;
  if (d.workspaceMode === "existing" && d.existingWorkspace)
    t += `\n  workspace:\n    name: ${q(d.existingWorkspace)}`;
  if (d.workspaceMode === "new")
    t += `\n  workspace:\n    name: ${q(d.wsName)}`;
  if (d.debug) t += "\n  debug: true";
  docs.push(t);

  return docs.join("\n---\n") + "\n";
}

// MARK: YAML syntax highlighter

export type YamlTok = { cls: string; text: string };

function tokenizeValue(s: string): YamlTok[] {
  const out: YamlTok[] = [];
  const re =
    /("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')|(\s#.*$)|(\b(?:true|false|null|yes|no)\b|-?\b\d+(?:\.\d+)?\b)|([[\]{},])|([^"'#[\]{},\s]+|\s+|.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) out.push({ cls: "y-str", text: m[1] });
    else if (m[2]) out.push({ cls: "y-comment", text: m[2] });
    else if (m[3]) out.push({ cls: "y-num", text: m[3] });
    else if (m[4]) out.push({ cls: "y-punct", text: m[4] });
    else if (/^\s*[|>][-+]?\s*$/.test(m[0]))
      out.push({ cls: "y-punct", text: m[0] });
    else out.push({ cls: "y-plain", text: m[0] });
  }
  return out;
}

export function tokenizeYAML(text: string): YamlTok[][] {
  const lines = text.replace(/\n$/, "").split("\n");
  let blockIndent = -1;
  return lines.map((line) => {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (!line.trim() || indent > blockIndent)
        return [{ cls: "y-block", text: line }];
      blockIndent = -1;
    }
    if (/^---\s*$/.test(line)) return [{ cls: "y-sep", text: line }];
    if (/^\s*#/.test(line)) return [{ cls: "y-comment", text: line }];
    const toks: YamlTok[] = [];
    let rest = line;
    const lead = /^(\s*)(- )?/.exec(rest)!;
    if (lead[1]) toks.push({ cls: "", text: lead[1] });
    if (lead[2]) toks.push({ cls: "y-punct", text: lead[2] });
    rest = rest.slice(lead[0].length);
    const key = /^([A-Za-z0-9_.\-/"']+)(:)(\s|$)/.exec(rest);
    if (key) {
      toks.push(
        { cls: "y-key", text: key[1] },
        { cls: "y-punct", text: key[2] },
      );
      rest = rest.slice(key[1].length + 1);
      if (/^\s*[|>][-+]?\s*$/.test(rest))
        blockIndent = indent + (lead[2] ? 2 : 0);
    }
    toks.push(...tokenizeValue(rest));
    return toks;
  });
}

// MARK: State

export class DesignerStore extends EventTarget {
  draft: Draft = template("simple");

  subscribe = (l: () => void): (() => void) => {
    this.addEventListener("change", l);
    return () => this.removeEventListener("change", l);
  };

  set(patch: Partial<Draft>): void {
    this.draft = { ...this.draft, ...patch };
    this.dispatchEvent(new Event("change"));
  }

  load(t: Template): void {
    this.draft = template(t);
    this.dispatchEvent(new Event("change"));
  }

  enterRawMode(): void {
    this.set({ rawYAML: generate(this.draft), rawMode: true });
  }

  async open(repoPath: string): Promise<void> {
    ensureStudioBridge();
    const f = await window.studio.openYAML(`${repoPath}/examples`);
    if (f) this.set({ rawYAML: f.text, rawMode: true, filePath: f.path });
  }

  async save(): Promise<void> {
    ensureStudioBridge();
    const name =
      this.draft.filePath?.split(/[\\/]/).pop() ?? `${this.draft.name}.yaml`;
    const path = await window.studio.saveYAML(name, generate(this.draft));
    if (path) this.set({ filePath: path });
  }
}

export const designer = new DesignerStore();
