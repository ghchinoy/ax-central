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

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunRequest {
  program: string;
  args: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface StreamRequest {
  id: string;
  commandLine: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface StreamLine {
  id: string;
  line: string;
}

export interface StreamExit {
  id: string;
  status: number;
}

export interface SessionRequest {
  id: string;
  program: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SessionData {
  id: string;
  data: string;
  stream: "stdout" | "stderr";
}

export interface PlatformInfo {
  os: "darwin" | "win32" | "linux" | string;
  home: string;
  pathSeparator: string;
  version: string;
}

export interface ContainerRuntime {
  runtime: "docker" | "podman" | null;
  env: Record<string, string>;
}

export interface TraySummary {
  scope: string;
  status: string;
  groups: {
    phase: string;
    tasks: { name: string; actions: ("resume" | "suspend")[] }[];
  }[];
}

export interface StudioAPI {
  platform(): Promise<PlatformInfo>;
  run(req: RunRequest): Promise<CommandResult>;
  stream(req: StreamRequest): Promise<void>;
  cancelStream(id: string): Promise<void>;
  onStreamLine(cb: (l: StreamLine) => void): () => void;
  onStreamExit(cb: (e: StreamExit) => void): () => void;
  startSession(req: SessionRequest): Promise<void>;
  writeSession(id: string, data: string): Promise<void>;
  interruptSession(id: string): Promise<void>;
  endSessionInput(id: string): Promise<void>;
  closeSession(id: string): Promise<void>;
  onSessionData(cb: (d: SessionData) => void): () => void;
  onSessionExit(cb: (e: StreamExit) => void): () => void;
  which(program: string): Promise<string | null>;
  updateTray(summary: TraySummary): void;
  kubeconfigFor(context: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  containerRuntime(): Promise<ContainerRuntime>;
  openYAML(defaultDir?: string): Promise<{ path: string; text: string } | null>;
  saveYAML(name: string, text: string): Promise<string | null>;
  onMenu(cb: (action: string) => void): () => void;
}

interface WailsAppBindings {
  Platform(): Promise<PlatformInfo>;
  Run(req: RunRequest): Promise<CommandResult>;
  Stream(req: StreamRequest): Promise<void>;
  CancelStream(id: string): Promise<void>;
  StartSession(req: SessionRequest): Promise<void>;
  WriteSession(id: string, data: string): Promise<void>;
  InterruptSession(id: string): Promise<void>;
  EndSessionInput(id: string): Promise<void>;
  CloseSession(id: string): Promise<void>;
  Which(program: string): Promise<string>;
  UpdateTray(summary: TraySummary): Promise<void>;
  KubeconfigFor(context: string): Promise<string>;
  FileExists(path: string): Promise<boolean>;
  ContainerRuntime(): Promise<{
    runtime: string;
    env: Record<string, string>;
  }>;
  OpenYAML(defaultDir: string): Promise<{ path: string; text: string } | null>;
  SaveYAML(name: string, text: string): Promise<string>;
}

interface WailsRuntime {
  EventsOn(
    eventName: string,
    callback: (...data: unknown[]) => void,
  ): () => void;
  WindowToggleMaximise?(): void;
}

declare global {
  interface Window {
    studio: StudioAPI;
    go?: {
      main?: {
        App?: WailsAppBindings;
      };
    };
    runtime?: WailsRuntime;
  }
}

function createWailsStudio(
  goApp: WailsAppBindings,
  rt?: WailsRuntime,
): StudioAPI {
  const onEvent = <T>(name: string, cb: (val: T) => void): (() => void) => {
    if (!rt?.EventsOn) return () => {};
    return rt.EventsOn(name, (data: unknown) => cb(data as T));
  };
  return {
    platform: () => goApp.Platform(),
    run: (req) => goApp.Run(req),
    stream: (req) => goApp.Stream(req),
    cancelStream: (id) => goApp.CancelStream(id),
    onStreamLine: (cb) => onEvent<StreamLine>("stream:line", cb),
    onStreamExit: (cb) => onEvent<StreamExit>("stream:exit", cb),
    startSession: (req) => goApp.StartSession(req),
    writeSession: (id, data) => goApp.WriteSession(id, data),
    interruptSession: (id) => goApp.InterruptSession(id),
    endSessionInput: (id) => goApp.EndSessionInput(id),
    closeSession: (id) => goApp.CloseSession(id),
    onSessionData: (cb) => onEvent<SessionData>("session:data", cb),
    onSessionExit: (cb) => onEvent<StreamExit>("session:exit", cb),
    which: async (prog) => {
      const p = await goApp.Which(prog);
      return p || null;
    },
    updateTray: (summary) => {
      void goApp.UpdateTray(summary);
    },
    kubeconfigFor: (ctx) => goApp.KubeconfigFor(ctx),
    fileExists: (p) => goApp.FileExists(p),
    containerRuntime: async () => {
      const r = await goApp.ContainerRuntime();
      const rtName =
        r.runtime === "docker" || r.runtime === "podman" ? r.runtime : null;
      return { runtime: rtName, env: r.env ?? {} };
    },
    openYAML: (dir) => goApp.OpenYAML(dir ?? ""),
    saveYAML: async (name, text) => {
      const p = await goApp.SaveYAML(name, text);
      return p || null;
    },
    onMenu: (cb) => onEvent<string>("menu", cb),
  };
}

/**
 * Fallback/mock StudioAPI used when running in a standalone browser or Vitest.
 */
export function createFallbackStudio(
  runHandler?: (req: RunRequest) => CommandResult | Promise<CommandResult>,
): StudioAPI {
  const defaultRun = (req: RunRequest): CommandResult => {
    const joined = [req.program, ...(req.args ?? [])].join(" ");
    if (req.args?.includes("version")) {
      return { status: 0, stdout: "ax version 0.3.1\n", stderr: "" };
    }
    if (joined.includes("config get-contexts")) {
      return {
        status: 0,
        stdout:
          "CURRENT   NAME      DESCRIPTION\n*         local     Local control plane\n          kind-ax   Kind cluster\n",
        stderr: "",
      };
    }
    if (req.args?.includes("tasks")) {
      return {
        status: 0,
        stdout:
          "ATESPACE   NAME            PHASE       ACTOR     WORKER-IP     AGE\ndefault    gemini-a1b2c3   Running     actor-1   10.244.0.12   4m\ndefault    shell-task-01   Suspended   <none>    <none>        18m\n",
        stderr: "",
      };
    }
    if (req.args?.includes("workspaces")) {
      return {
        status: 0,
        stdout:
          "ATESPACE   NAME              GIT-REPOS   MCP-SERVERS\ndefault    humanize-gemini   1           0\n",
        stderr: "",
      };
    }
    if (req.args?.includes("models")) {
      return {
        status: 0,
        stdout:
          "ATESPACE   NAME            PROVIDER   MODEL\ndefault    default-model   google     gemini-3.8-flash\n",
        stderr: "",
      };
    }
    if (req.args?.includes("task")) {
      const name = req.args[req.args.length - 1] ?? "task";
      return {
        status: 0,
        stdout: `apiVersion: ax.io/v1alpha1\nkind: Task\nmetadata:\n  name: ${name}\n  createTime: "2026-11-01T12:00:00Z"\nspec:\n  image: ghcr.io/rakyll/ax-images/gemini@sha256:e3d8d95\n  workspace:\n    name: humanize-gemini\n  resources:\n    limits:\n      cpu: "2"\n      memory: "4Gi"\n  debug: true\nstatus:\n  phase: Running\n  conditions:\n    - type: WorkspaceReady\n      status: "True"\n      reason: Mounted\n      message: Workspace mounted at /workspace\n    - type: Ready\n      status: "True"\n      reason: SandboxRunning\n      message: Task sandbox is running\n`,
        stderr: "",
      };
    }
    if (req.args?.includes("workspace")) {
      return {
        status: 0,
        stdout: `apiVersion: ax.io/v1alpha1\nkind: Workspace\nmetadata:\n  name: humanize-gemini\nspec:\n  git:\n    - name: origin\n      repo: https://github.com/python-humanize/humanize.git\n      branch: main\n  files:\n    - path: AGENTS.md\n`,
        stderr: "",
      };
    }
    if (req.program === "kind" && req.args?.includes("clusters")) {
      return { status: 0, stdout: "ax-dev\n", stderr: "" };
    }
    if (req.program === "/bin/sh" && req.args?.[2] === "probe-ate-local") {
      return {
        status: 0,
        stdout:
          "postgres=1\natelocal=1\naxserver=1\ndaemon=1\nagentimg=1\nactors=ate-default-gemini-a1b2c3|running|192.168.64.81\n",
        stderr: "",
      };
    }
    if (req.program === "/bin/sh" && req.args?.[2] === "probe") {
      return {
        status: 0,
        stdout:
          "reachable=1\nnodes=1/1\nversion=v1.32.0\nsubstrate=1/1\ncommit=a1b2c3d\nax=1/1\nworkers=2/2\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "ok\n", stderr: "" };
  };

  const lineListeners = new Set<(l: StreamLine) => void>();
  const exitListeners = new Set<(e: StreamExit) => void>();

  return {
    platform: async () => ({
      os: "darwin",
      home: "/Users/dev",
      pathSeparator: ":",
      version: "0.3.0",
    }),
    run: async (req) => (runHandler ? runHandler(req) : defaultRun(req)),
    stream: async (req) => {
      queueMicrotask(() => {
        if (req.commandLine.includes("container logs")) {
          for (const cb of lineListeners) {
            cb({
              id: req.id,
              line: 'time=2026-11-01T12:00:01Z level=INFO msg="starting guest runner"',
            });
            cb({
              id: req.id,
              line: 'time=2026-11-01T12:00:02Z level=INFO msg="genkit otel span" agent=triage_agent span=triage_agent type=action subtype=flow status=success duration_ms=42.50 start_unix_nano=1794022923000000000 end_unix_nano=1794022923042500000 trace_id=4ff8c58f13d6b4dff65b657638b245bb span_id=848dd100f712d9e4',
            });
            cb({ id: req.id, line: "Linux aarch64" });
          }
        } else if (req.commandLine.includes("ate.dev/worker-pool")) {
          for (const cb of lineListeners) {
            cb({
              id: req.id,
              line: JSON.stringify({
                labels: {
                  "ate.actor.name": "gemini-a1b2c3",
                  "ate.atespace": "default",
                },
                message: "Actor started",
                time: "2026-11-01T12:00:01Z",
                trace_id: "4ff8c58f13d6b4dff65b657638b245bb",
                span_id: "848dd100f712d9e4",
              }),
            });
            cb({
              id: req.id,
              line: JSON.stringify({
                msg: "Actor usage sampled",
                "ate.atespace": "default",
                "ate.actor.name": "gemini-a1b2c3",
                "ate.stats.kind": "initial",
                "ate.stats.memory.working_set": 25165824,
                "ate.stats.memory.peak": 31457280,
                "ate.stats.cpu.time": 0.42,
                trace_id: "4ff8c58f13d6b4dff65b657638b245bb",
              }),
            });
            cb({
              id: req.id,
              line: JSON.stringify({
                labels: {
                  "ate.actor.container.name": "guest",
                  "ate.actor.name": "gemini-a1b2c3",
                  "ate.atespace": "default",
                },
                message:
                  'time=2026-11-01T12:00:02Z level=INFO msg="genkit otel span" agent=triage_agent span=read_file type=action subtype=tool status=success duration_ms=12.40 start_unix_nano=1794022923010000000 end_unix_nano=1794022923022400000 trace_id=4ff8c58f13d6b4dff65b657638b245bb span_id=1122334455667788',
                time: "2026-11-01T12:00:02Z",
              }),
            });
          }
        } else {
          for (const cb of lineListeners) {
            cb({ id: req.id, line: "==> Completed stream command" });
          }
          for (const cb of exitListeners) {
            cb({ id: req.id, status: 0 });
          }
        }
      });
    },
    cancelStream: async () => {},
    onStreamLine: (cb) => {
      lineListeners.add(cb);
      return () => lineListeners.delete(cb);
    },
    onStreamExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    startSession: async () => {},
    writeSession: async () => {},
    interruptSession: async () => {},
    endSessionInput: async () => {},
    closeSession: async () => {},
    onSessionData: () => () => {},
    onSessionExit: () => () => {},
    which: async (prog) => `/usr/local/bin/${prog}`,
    updateTray: () => {},
    kubeconfigFor: async (ctx) => `/tmp/kubeconfig-${ctx}`,
    fileExists: async () => true,
    containerRuntime: async () => ({ runtime: "docker", env: {} }),
    openYAML: async () => null,
    saveYAML: async () => null,
    onMenu: () => () => {},
  };
}

export function ensureStudioBridge(): StudioAPI {
  if (window.go?.main?.App) {
    window.studio = createWailsStudio(window.go.main.App, window.runtime);
  } else if (!window.studio) {
    window.studio = createFallbackStudio();
  }
  return window.studio;
}
