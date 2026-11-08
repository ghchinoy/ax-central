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

import { type CommandResult, ensureStudioBridge } from "../bridge";
import {
  type AXContext,
  type AXModel,
  type AXTask,
  type AXWorkspace,
  type Phase,
  type TaskDetail,
  comparePhase,
  errorSummary,
  isLocalContext,
  isSafeResourceName,
  parseContexts,
  parseModels,
  parseTaskYAML,
  parseTasks,
  parseWorkspaceYAML,
  parseWorkspaces,
  toPhase,
} from "./resources";

export type Section =
  "overview" | "topology" | "terminal" | "designer" | "clusters";
export const SECTIONS: Section[] = [
  "overview",
  "topology",
  "designer",
  "terminal",
  "clusters",
];

export interface ActivityEntry {
  id: number;
  date: number;
  title: string;
  detail: string;
  ok: boolean;
}

/** Phase counts at one refresh, for the "tasks over time" chart. */
export interface PhaseSample {
  date: number;
  counts: Record<string, number>;
}

export interface WorkspaceSnapshot {
  name: string;
  atespace: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface DVRFrame {
  date: number;
  label: string;
  note?: string;
  tasks: AXTask[];
  workspaces: AXWorkspace[];
  details: Record<string, TaskDetail>;
}

export function parseTraceJSONLToFrames(text: string): DVRFrame[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const rawEvents: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      rawEvents.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip invalid JSON line
    }
  }
  if (rawEvents.length === 0) return [];

  const t0 = Number(rawEvents[0]?.t) || 0;
  const tasksMap = new Map<string, AXTask>();
  const detailsMap: Record<string, TaskDetail> = {};
  const frames: DVRFrame[] = [];

  const pushFrame = (tSec: number, note?: string) => {
    const relSec = Math.max(0, tSec - t0);
    const clonedTasks = [...tasksMap.values()].map((tk) => ({ ...tk }));
    const clonedDetails: Record<string, TaskDetail> = {};
    for (const [k, v] of Object.entries(detailsMap)) {
      clonedDetails[k] = {
        ...v,
        targets: v.targets ? [...v.targets] : undefined,
      };
    }
    frames.push({
      date: Math.round(tSec * 1000),
      label: `+${relSec.toFixed(1)}s`,
      note,
      tasks: clonedTasks,
      workspaces: [],
      details: clonedDetails,
    });
  };

  const ensureTask = (name: string, role?: string): AXTask => {
    const id = `default/${name}`;
    let tk = tasksMap.get(name);
    if (!tk) {
      const isCoord = role === "coordinator" || name.includes("router");
      tk = {
        id,
        name,
        atespace: "default",
        phase: isCoord ? "running" : "suspended",
        age: "0s",
      };
      tasksMap.set(name, tk);
      detailsMap[id] = {
        command: [],
        env: [],
        debug: true,
        conditions: [],
        manifest: "",
      };
    }
    return tk;
  };

  const addRouterTarget = (routerName: string, targetName: string) => {
    ensureTask(routerName, "coordinator");
    ensureTask(targetName, "worker");
    const rID = `default/${routerName}`;
    const cur = detailsMap[rID]?.targets ?? [];
    if (!cur.includes(targetName)) {
      detailsMap[rID] = {
        ...detailsMap[rID]!,
        targets: [...cur, targetName],
      };
    }
  };

  for (const ev of rawEvents) {
    const kind = String(ev.kind ?? "");
    const tSec = Number(ev.t) || t0;
    const id = typeof ev.id === "string" ? ev.id : "";
    const from = typeof ev.from === "string" ? ev.from : "";
    const to = typeof ev.to === "string" ? ev.to : "";
    const label = typeof ev.label === "string" ? ev.label : "";
    const role = typeof ev.role === "string" ? ev.role : undefined;

    if (kind === "node.add" && id) {
      ensureTask(id, role);
      if (id.includes("router")) {
        for (const other of tasksMap.keys()) {
          if (other !== id) addRouterTarget(id, other);
        }
      } else {
        for (const other of tasksMap.keys()) {
          if (other.includes("router")) addRouterTarget(other, id);
        }
      }
      pushFrame(tSec, label || `Added ${id}`);
    } else if ((kind === "node.phase" || kind === "node.ready") && id) {
      const tk = ensureTask(id, role);
      tk.phase =
        kind === "node.ready" ? "running" : toPhase(String(ev.phase ?? ""));
      if (typeof ev.workerIP === "string") tk.workerIP = ev.workerIP;
      pushFrame(tSec, label || `${id} → ${tk.phase}`);
    } else if (kind === "node.remove" && id) {
      tasksMap.delete(id);
      pushFrame(tSec, `Removed ${id}`);
    } else if (kind === "note") {
      const m = /targets=([a-zA-Z0-9_,-]+(?:\s+[a-zA-Z0-9_,-]+)*)/.exec(label);
      if (m?.[1]) {
        const targets = m[1]
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const r of tasksMap.keys()) {
          if (r.includes("router")) {
            for (const tgt of targets) addRouterTarget(r, tgt);
          }
        }
      }
      pushFrame(tSec, label);
    } else if (kind === "edge.msg" || kind === "edge.exec") {
      if (from && to && from !== "host" && to !== "host") {
        const isReply = /reply/i.test(label);
        if (!isReply) {
          addRouterTarget(from, to);
          const targetTask = ensureTask(to, "worker");
          targetTask.phase = "running";
          pushFrame(tSec, `${from} → ${to}: ${label}`);
        } else {
          addRouterTarget(to, from);
          const sourceTask = ensureTask(from, "worker");
          sourceTask.phase = "suspended";
          pushFrame(tSec, `${from} → ${to}: ${label}`);
        }
      } else if (to && to !== "host") {
        const tk = ensureTask(to);
        tk.phase = "running";
        pushFrame(tSec, `${from || "host"} → ${to}: ${label}`);
      }
    } else if (kind === "run.end") {
      for (const tk of tasksMap.values()) {
        if (!tk.name.includes("router")) tk.phase = "suspended";
      }
      pushFrame(tSec, `Run completed (${label || id})`);
    }
  }
  return frames;
}

export interface Settings {
  axPath: string;
  repoPath: string;
  experimentsPath: string;
  localServer: string;
  localServerB: string;
  refreshInterval: number;
}

export interface TerminalTab {
  key: string;
  task: AXTask;
  context: string;
  scope: string[];
}

export interface State {
  section: Section;
  contexts: AXContext[];
  context: string;
  atespace: string;
  tasks: AXTask[];
  workspaces: AXWorkspace[];
  models: AXModel[];
  details: Record<string, TaskDetail>;
  selectedTaskID: string | null;
  isRefreshing: boolean;
  lastRefresh: number | null;
  connectionError: string | null;
  activity: ActivityEntry[];
  history: PhaseSample[];
  snapshots: WorkspaceSnapshot[];
  dvrFrames: DVRFrame[];
  axVersion: string | null;
  axConfig: boolean;
  localAxBin: string | null;
  repoAxBin: string | null;
  kindKubeconfigs: Record<string, string>;
  terminalTabs: TerminalTab[];
  terminalActive: string | null;
  settings: Settings;
  settingsOpen: boolean;
  webmcpOpen: boolean;
  os: string;
}

let tabCount = 0;

const SETTINGS_KEY = "ax-central.settings";
const SECTION_KEY = "ax-central.section";
const CONTEXT_KEY = "ax-central.context";

function loadSettings(): Settings {
  const defaults: Settings = {
    axPath: "ax",
    repoPath: "~/projects/ax",
    experimentsPath: "~/projects/ax-experiments",
    localServer: "localhost:8090",
    localServerB: "localhost:8091",
    refreshInterval: 4,
  };
  try {
    return {
      ...defaults,
      ...(JSON.parse(
        localStorage.getItem(SETTINGS_KEY) ?? "{}",
      ) as Partial<Settings>),
    };
  } catch {
    return defaults;
  }
}

const result = (r: CommandResult) => ({
  ...r,
  ok: r.status === 0,
  error: errorSummary(r.stdout, r.stderr),
});
export type Result = ReturnType<typeof result>;

export class Store extends EventTarget {
  state: State = {
    section:
      [
        new URLSearchParams(location.search).get("section"),
        localStorage.getItem(SECTION_KEY),
      ].find((x): x is Section => SECTIONS.includes(x as Section)) ??
      "overview",
    contexts: [],
    context: "",
    atespace: new URLSearchParams(location.search).get("atespace") || "default",
    tasks: [],
    workspaces: [],
    models: [],
    details: {},
    selectedTaskID: null,
    isRefreshing: false,
    lastRefresh: null,
    connectionError: null,
    activity: [],
    history: [],
    snapshots: [],
    dvrFrames: [],
    axVersion: null,
    axConfig: true,
    localAxBin: null,
    repoAxBin: null,
    kindKubeconfigs: {},
    terminalTabs: [],
    terminalActive: null,
    settings: loadSettings(),
    settingsOpen: false,
    webmcpOpen: false,
    os: "darwin",
  };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  private nextID = 1;
  private detailSig = new Map<string, string>();
  private wsSig = new Map<string, string>();
  private askedTask = new URLSearchParams(location.search).get("task");
  private askedTerminal = new URLSearchParams(location.search).has("terminal");

  private takeAskedTask(tasks: AXTask[]): Partial<State> {
    const t = this.askedTask
      ? tasks.find((x) => x.name === this.askedTask)
      : undefined;
    if (!t) return {};
    this.askedTask = null;
    if (!this.askedTerminal) return { selectedTaskID: t.id };
    const tab = this.newTab(t);
    return {
      selectedTaskID: t.id,
      section: "terminal",
      terminalTabs: [...this.state.terminalTabs, tab],
      terminalActive: tab.key,
    };
  }

  subscribe = (l: () => void): (() => void) => {
    this.addEventListener("change", l);
    return () => this.removeEventListener("change", l);
  };

  set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.dispatchEvent(new Event("change"));
  }

  get currentContext(): AXContext | undefined {
    return this.state.contexts.find((c) => c.name === this.state.context);
  }

  tasksIn = (p: Phase) => this.state.tasks.filter((t) => t.phase === p);
  tasksUsing = (ws: string) =>
    this.state.tasks.filter((t) => this.state.details[t.id]?.workspace === ws);

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      ensureStudioBridge();
      const info = await window.studio.platform();
      document.documentElement.dataset.os = info.os;
      this.set({ os: info.os });
      await this.loadContexts();
      await this.loop();
    })();
    return this.startPromise;
  }

  private loop = async (): Promise<void> => {
    await this.refresh();
    const hasActive = this.state.tasks.some(
      (t) =>
        t.phase === "running" ||
        t.phase === "pending" ||
        t.phase === "terminating",
    );
    const intervalSec = hasActive
      ? 1.5
      : Math.max(1.5, this.state.settings.refreshInterval);
    this.timer = setTimeout(this.loop, intervalSec * 1000);
  };

  setSection(section: Section): void {
    localStorage.setItem(SECTION_KEY, section);
    this.set({ section });
  }

  updateSettings(patch: Partial<Settings>): void {
    const settings = { ...this.state.settings, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    this.set({ settings });
  }

  setScope(patch: { context?: string; atespace?: string }): void {
    if (patch.context) {
      localStorage.setItem(CONTEXT_KEY, patch.context);
    }
    this.detailSig.clear();
    this.wsSig.clear();
    this.set({
      ...patch,
      tasks: [],
      workspaces: [],
      models: [],
      details: {},
      history: [],
      snapshots: [],
      dvrFrames: [],
      selectedTaskID: null,
      connectionError: null,
    });
    void this.refresh();
  }

  showTask(name: string | null): void {
    this.askedTask = name;
    this.askedTerminal = false;
    this.set(this.takeAskedTask(this.state.tasks));
    this.setSection("overview");
  }

  async loadContexts(): Promise<void> {
    ensureStudioBridge();
    const info = await window.studio.platform();
    const repoExpanded = this.state.settings.repoPath.replace(/^~/, info.home);
    const candidateLocalAx = `${repoExpanded}/.ax-local/bin/ax`;
    const candidateTmpAx = `${repoExpanded}/.tmp/bin/ax`;
    const candidateRepoBinAx = `${repoExpanded}/bin/ax`;
    const candidateClusterBConfig = `${repoExpanded}/.ax-local/ate-local-b.yaml`;
    const [hasLocalAx, hasTmpAx, hasRepoBinAx, hasClusterBConfig, podmanBin] =
      await Promise.all([
        window.studio.fileExists(candidateLocalAx),
        window.studio.fileExists(candidateTmpAx),
        window.studio.fileExists(candidateRepoBinAx),
        window.studio.fileExists(candidateClusterBConfig),
        window.studio.which("podman"),
      ]);
    const repoAxBin = hasTmpAx
      ? candidateTmpAx
      : hasRepoBinAx
        ? candidateRepoBinAx
        : null;
    this.set({
      localAxBin: hasLocalAx ? candidateLocalAx : null,
      repoAxBin,
    });

    const v = result(
      await window.studio.run({
        program: this.effectiveAxPath,
        args: ["version"],
      }),
    );
    this.set({ axVersion: v.ok ? v.stdout.trim() : null });
    const r = result(
      await window.studio.run({
        program: this.effectiveAxPath,
        args: ["config", "get-contexts"],
      }),
    );
    let contexts: AXContext[];
    let kindKubeconfigs: Record<string, string> = {};
    if (r.ok) {
      contexts = parseContexts(r.stdout);
      this.set({ axConfig: true });
    } else if (/unknown command/i.test(r.stderr + r.stdout)) {
      const kc = await kubeContexts(repoExpanded);
      contexts = kc.contexts;
      kindKubeconfigs = kc.kindKubeconfigs;
      this.set({ axConfig: false, kindKubeconfigs });
    } else {
      const kc = await kubeContexts(repoExpanded);
      contexts = kc.contexts;
      kindKubeconfigs = kc.kindKubeconfigs;
      this.set({ kindKubeconfigs });
    }
    if (!contexts.some((c) => c.name === "local")) {
      const localCtx: AXContext = {
        name: "local",
        description: `Local Apple container (Cluster A · ${this.state.settings.localServer})`,
        isCurrent: contexts.length === 0 && info.os === "darwin",
      };
      contexts =
        info.os === "darwin"
          ? [localCtx, ...contexts]
          : [...contexts, localCtx];
    }
    if (
      (hasClusterBConfig || hasLocalAx || !!podmanBin) &&
      !contexts.some((c) => c.name === "local-podman")
    ) {
      const serverB = this.state.settings.localServerB || "localhost:8091";
      const clusterBCtx: AXContext = {
        name: "local-podman",
        description: `Local Podman container (Cluster B · ${serverB})`,
        isCurrent: false,
      };
      const localIdx = contexts.findIndex((c) => c.name === "local");
      if (localIdx >= 0) {
        contexts = [
          ...contexts.slice(0, localIdx + 1),
          clusterBCtx,
          ...contexts.slice(localIdx + 1),
        ];
      } else {
        contexts = [...contexts, clusterBCtx];
      }
    }
    const asked = new URLSearchParams(location.search).get("context");
    const saved = localStorage.getItem(CONTEXT_KEY);
    const last = saved
      ? contexts.find((c) => c.name === saved)?.name
      : undefined;
    const defaultCtx =
      contexts.find((c) => c.isCurrent)?.name ||
      (info.os !== "darwin"
        ? contexts.find((c) => !isLocalContext(c.name))?.name
        : undefined) ||
      "local";
    this.set({
      contexts,
      context: this.state.context || asked || last || defaultCtx,
    });
  }

  axPathFor(context: string): string {
    if (this.state.settings.axPath === "ax") {
      if (isLocalContext(context) && this.state.localAxBin) {
        return this.state.localAxBin;
      }
      if (this.state.repoAxBin) {
        return this.state.repoAxBin;
      }
    }
    return this.state.settings.axPath;
  }

  get effectiveAxPath(): string {
    return this.axPathFor(this.state.context);
  }

  scopeFor(context: string, atespace: string): string[] {
    const a: string[] = [];
    if (context === "local") {
      a.push("--server", this.state.settings.localServer || "localhost:8090");
    } else if (context === "local-podman" || context === "local-b") {
      a.push("--server", this.state.settings.localServerB || "localhost:8091");
    } else if (context && isSafeResourceName(context)) {
      a.push("--context", context);
    }
    const ates =
      atespace && isSafeResourceName(atespace) ? atespace : "default";
    a.push("-a", ates);
    return a;
  }

  get scope(): string[] {
    return this.scopeFor(this.state.context, this.state.atespace);
  }

  envFor(context: string): Record<string, string> | undefined {
    if (context === "local") {
      return { AX_SERVER: this.state.settings.localServer || "localhost:8090" };
    }
    if (context === "local-podman" || context === "local-b") {
      return {
        AX_SERVER: this.state.settings.localServerB || "localhost:8091",
      };
    }
    const kc = this.state.kindKubeconfigs[context];
    if (kc) {
      return { KUBECONFIG: kc };
    }
    return undefined;
  }

  get envForContext(): Record<string, string> | undefined {
    return this.envFor(this.state.context);
  }

  async ax(args: string[], stdin?: string): Promise<Result> {
    ensureStudioBridge();
    return result(
      await window.studio.run({
        program: this.effectiveAxPath,
        args: [...this.scope, ...args],
        stdin,
        env: this.envForContext,
      }),
    );
  }

  async perform(
    title: string,
    args: string[],
    stdin?: string,
  ): Promise<Result> {
    const r = await this.ax(args, stdin);
    this.log(title, r.ok ? r.stdout.trim() : r.error, r.ok);
    await this.refresh(true);
    return r;
  }

  log(title: string, detail: string, ok: boolean): void {
    const entry: ActivityEntry = {
      id: this.nextID++,
      date: Date.now(),
      title,
      detail,
      ok,
    };
    this.set({ activity: [entry, ...this.state.activity].slice(0, 200) });
  }

  async refresh(force = false): Promise<void> {
    if ((this.state.isRefreshing && !force) || !this.state.context) return;
    this.set({ isRefreshing: true });
    try {
      const [tr, wr, mr] = await Promise.all([
        this.ax(["get", "tasks"]),
        this.ax(["get", "workspaces"]),
        this.ax(["get", "models"]),
      ]);
      if (!tr.ok) {
        this.set({ connectionError: tr.error });
        return;
      }
      const tasks = parseTasks(tr.stdout).sort(
        (a, b) =>
          comparePhase(a.phase, b.phase) || a.name.localeCompare(b.name),
      );
      const workspaces = wr.ok
        ? parseWorkspaces(wr.stdout).map((w) => {
            const old = this.state.workspaces.find((o) => o.id === w.id);
            return old
              ? {
                  ...w,
                  repos: old.repos,
                  mcpServers: old.mcpServers,
                  files: old.files,
                }
              : w;
          })
        : this.state.workspaces;
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.phase] = (counts[t.phase] ?? 0) + 1;
      const [fetched, snapshots] = await Promise.all([
        this.fetchDetails(tasks, workspaces, force),
        isLocalContext(this.state.context)
          ? this.loadSnapshots()
          : Promise.resolve([] as WorkspaceSnapshot[]),
      ]);
      const now = Date.now();
      const prevFrame = this.state.dvrFrames[this.state.dvrFrames.length - 1];
      const frameSig = (tList: AXTask[], wList: AXWorkspace[]) =>
        `${tList.map((t) => `${t.id}:${t.phase}:${t.workerIP ?? ""}`).join(",")}|${wList.map((w) => w.id).join(",")}`;
      const curSig = frameSig(tasks, fetched.workspaces);
      const prevSig = prevFrame
        ? frameSig(prevFrame.tasks, prevFrame.workspaces)
        : null;
      let dvrFrames = this.state.dvrFrames;
      if (
        (tasks.length > 0 || prevFrame) &&
        (prevSig === null || curSig !== prevSig)
      ) {
        const runningNames = tasks
          .filter((t) => t.phase === "running")
          .map((t) => t.name);
        const note =
          tasks.length === 0
            ? "All tasks removed"
            : runningNames.length > 0
              ? `Running: ${runningNames.join(", ")}`
              : `${tasks.length} task${tasks.length === 1 ? "" : "s"} suspended`;
        const tStr = new Date(now).toTimeString().slice(0, 8);
        dvrFrames = [
          ...dvrFrames,
          {
            date: now,
            label: tStr,
            note,
            tasks: tasks.map((t) => ({ ...t })),
            workspaces: fetched.workspaces,
            details: { ...fetched.details },
          },
        ].slice(-120);
      }

      this.set({
        connectionError: null,
        tasks: same(tasks, this.state.tasks) ? this.state.tasks : tasks,
        ...this.takeAskedTask(tasks),
        workspaces: fetched.workspaces,
        details: fetched.details,
        models: mr.ok ? parseModels(mr.stdout) : this.state.models,
        snapshots,
        dvrFrames,
        lastRefresh: now,
        history: [...this.state.history, { date: now, counts }].slice(-360),
      });
    } finally {
      this.set({ isRefreshing: false });
    }
  }

  private async loadSnapshots(): Promise<WorkspaceSnapshot[]> {
    ensureStudioBridge();
    const ates =
      this.state.atespace && isSafeResourceName(this.state.atespace)
        ? this.state.atespace
        : "default";
    const info = await window.studio.platform();
    const repoExpanded = this.state.settings.repoPath.replace(/^~/, info.home);
    const snapDir = `${repoExpanded}/.ax-local/snapshots/${ates}`;
    const r = await window.studio.run({
      program: "/bin/sh",
      args: [
        "-c",
        'dir="$1"; [ -d "$dir" ] || exit 0; for f in "$dir"/*.tar.gz; do [ -f "$f" ] || continue; stat -f "%N|%z|%Sm" -t "%Y-%m-%d %H:%M:%S" "$f" 2>/dev/null || stat -c "%n|%s|%y" "$f" 2>/dev/null; done',
        "probe-snapshots",
        snapDir,
      ],
    });
    if (r.status !== 0 || !r.stdout.trim()) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("|"))
      .map((l) => {
        const [p, sz, dt] = l.split("|");
        const base = (p.split("/").pop() || p).replace(/\.tar\.gz$/, "");
        return {
          name: base,
          atespace: ates,
          path: p,
          sizeBytes: Number(sz) || 0,
          updatedAt: (dt || "").trim(),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async inspectSnapshot(snap: WorkspaceSnapshot): Promise<{
    files: string[];
    previews: Record<string, string>;
  }> {
    ensureStudioBridge();
    const r = await window.studio.run({
      program: "python3",
      args: [
        "-c",
        [
          "import json, sys, tarfile",
          "files, previews = [], {}",
          "with tarfile.open(sys.argv[1], 'r:gz') as tf:",
          "  for m in tf.getmembers():",
          "    if not m.isfile(): continue",
          "    name = m.name.lstrip('./')",
          "    if not name or name.startswith('.git/'): continue",
          "    files.append(name)",
          "    if m.size <= 32768:",
          "      f = tf.extractfile(m)",
          "      if f:",
          "        raw = f.read(32768)",
          "        try: previews[name] = raw.decode('utf-8')",
          "        except Exception: pass",
          "print(json.dumps({'files': sorted(files), 'previews': previews}))",
        ].join("\n"),
        snap.path,
      ],
    });
    if (r.status === 0 && r.stdout.trim()) {
      try {
        return JSON.parse(r.stdout) as {
          files: string[];
          previews: Record<string, string>;
        };
      } catch {
        // fall through
      }
    }
    return { files: [], previews: {} };
  }

  async removeSnapshot(snap: WorkspaceSnapshot): Promise<void> {
    ensureStudioBridge();
    await window.studio.run({
      program: "/bin/sh",
      args: ["-c", 'rm -f "$1"', "rm-snapshot", snap.path],
    });
    this.log(`Delete snapshot ${snap.name}`, snap.path, true);
    await this.refresh(true);
  }

  async listTraceFiles(): Promise<{ name: string; path: string }[]> {
    ensureStudioBridge();
    const info = await window.studio.platform();
    const expExpanded = this.state.settings.experimentsPath.replace(
      /^~/,
      info.home,
    );
    const traceDir = `${expExpanded}/viz/traces`;
    const r = await window.studio.run({
      program: "/bin/sh",
      args: [
        "-c",
        'dir="$1"; [ -d "$dir" ] || exit 0; for f in "$dir"/*.jsonl; do [ -f "$f" ] && printf "%s\\n" "$f"; done',
        "list-traces",
        traceDir,
      ],
    });
    if (r.status !== 0 || !r.stdout.trim()) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => ({
        name: (p.split("/").pop() || p).replace(/\.jsonl$/, ""),
        path: p,
      }));
  }

  async loadTraceFile(path: string): Promise<DVRFrame[]> {
    ensureStudioBridge();
    const r = await window.studio.run({
      program: "/bin/sh",
      args: ["-c", 'cat "$1"', "read-trace", path],
    });
    if (r.status !== 0 || !r.stdout.trim()) return [];
    return parseTraceJSONLToFrames(r.stdout);
  }

  private async fetchDetails(
    taskList: AXTask[],
    workspaceList: AXWorkspace[],
    force = false,
  ): Promise<{
    details: Record<string, TaskDetail>;
    workspaces: AXWorkspace[];
  }> {
    const tasks = taskList.filter((t) => isSafeResourceName(t.name));
    const taskSigFor = (t: AXTask) =>
      `${t.phase}:${t.workerIP ?? ""}:${t.actor ?? ""}`;
    const tasksToFetch = tasks.filter(
      (t) =>
        force ||
        !this.state.details[t.id] ||
        this.detailSig.get(t.id) !== taskSigFor(t) ||
        t.id === this.state.selectedTaskID,
    );
    const results = await Promise.all(
      tasksToFetch.map((t) => this.ax(["get", "task", t.name])),
    );
    const fetchedTaskMap = new Map<string, TaskDetail>();
    tasksToFetch.forEach((t, i) => {
      const r = results[i];
      if (r?.ok) {
        fetchedTaskMap.set(t.id, parseTaskYAML(r.stdout));
        this.detailSig.set(t.id, taskSigFor(t));
      }
    });
    const details: Record<string, TaskDetail> = {};
    for (const t of tasks) {
      const d = fetchedTaskMap.get(t.id) ?? this.state.details[t.id];
      if (d) details[t.id] = d;
    }

    const safeWorkspaces = workspaceList.filter((w) =>
      isSafeResourceName(w.name),
    );
    const wsSigFor = (w: AXWorkspace) => `${w.gitCount}:${w.mcpCount}`;
    const wsToFetch = safeWorkspaces.filter(
      (w) => force || this.wsSig.get(w.id) !== wsSigFor(w),
    );
    const wsResults = await Promise.all(
      wsToFetch.map((w) => this.ax(["get", "workspace", w.name])),
    );
    const wsMap = new Map<string, AXWorkspace>();
    wsToFetch.forEach((w, i) => {
      if (wsResults[i]?.ok) {
        wsMap.set(w.id, parseWorkspaceYAML(wsResults[i].stdout, w));
        this.wsSig.set(w.id, wsSigFor(w));
      }
    });
    const workspaces = workspaceList.map((w) => wsMap.get(w.id) ?? w);
    return { details, workspaces };
  }

  private invalidNameResult(name: string): Result {
    return result({
      status: 1,
      stdout: "",
      stderr: `Error: invalid resource identifier "${name}"`,
    });
  }

  suspend = async (t: AXTask): Promise<Result> =>
    isSafeResourceName(t.name)
      ? this.perform(`Suspend ${t.name}`, ["suspend", "task", t.name])
      : this.invalidNameResult(t.name);
  resume = async (t: AXTask): Promise<Result> =>
    isSafeResourceName(t.name)
      ? this.perform(`Resume ${t.name}`, ["resume", "task", t.name])
      : this.invalidNameResult(t.name);
  remove = async (kind: string, name: string): Promise<Result> =>
    isSafeResourceName(kind) && isSafeResourceName(name)
      ? this.perform(`Delete ${kind} ${name}`, ["delete", kind, name])
      : this.invalidNameResult(name);
  apply = (yaml: string) =>
    this.perform("Apply manifest", ["apply", "-f", "-"], yaml);

  async resumeAll(tasks?: AXTask[]): Promise<void> {
    const targets = (
      tasks ??
      this.state.tasks.filter(
        (t) =>
          t.phase === "suspended" ||
          t.phase === "failed" ||
          t.phase === "completed",
      )
    ).filter((t) => isSafeResourceName(t.name));
    if (!targets.length) return;
    const results = await Promise.all(
      targets.map((t) => this.ax(["resume", "task", t.name])),
    );
    const ok = results.every((r) => r.ok);
    const firstErr = results.find((r) => !r.ok)?.error ?? "";
    this.log(
      `Resume ${targets.length} tasks`,
      ok ? targets.map((t) => t.name).join(", ") : firstErr,
      ok,
    );
    await this.refresh(true);
  }

  async suspendAll(tasks?: AXTask[]): Promise<void> {
    const targets = (
      tasks ??
      this.state.tasks.filter(
        (t) => t.phase === "running" || t.phase === "pending",
      )
    ).filter((t) => isSafeResourceName(t.name));
    if (!targets.length) return;
    const results = await Promise.all(
      targets.map((t) => this.ax(["suspend", "task", t.name])),
    );
    const ok = results.every((r) => r.ok);
    const firstErr = results.find((r) => !r.ok)?.error ?? "";
    this.log(
      `Suspend ${targets.length} tasks`,
      ok ? targets.map((t) => t.name).join(", ") : firstErr,
      ok,
    );
    await this.refresh(true);
  }

  async makeDefault(ctx: string): Promise<void> {
    if (!this.state.axConfig || !isSafeResourceName(ctx)) return;
    const r = result(
      await window.studio.run({
        program: this.state.settings.axPath,
        args: ["config", "use-context", ctx],
      }),
    );
    this.log(
      `Use context ${ctx}`,
      r.ok ? "now the default for ax" : r.error,
      r.ok,
    );
    await this.loadContexts();
  }

  private newTab(t: AXTask): TerminalTab {
    return {
      key: `tab-${++tabCount}`,
      task: t,
      context: this.state.context,
      scope: this.scope,
    };
  }

  openTerminal(t: AXTask): void {
    const open = this.state.terminalTabs.find(
      (x) => x.task.id === t.id && x.context === this.state.context,
    );
    if (open) {
      this.set({ terminalActive: open.key });
    } else {
      const tab = this.newTab(t);
      this.set({
        terminalTabs: [...this.state.terminalTabs, tab],
        terminalActive: tab.key,
      });
    }
    this.setSection("terminal");
  }

  duplicateTerminal(tab: TerminalTab): void {
    const copy = { ...tab, key: `tab-${++tabCount}` };
    const tabs = [...this.state.terminalTabs];
    tabs.splice(tabs.indexOf(tab) + 1, 0, copy);
    this.set({ terminalTabs: tabs, terminalActive: copy.key });
  }

  closeTerminal(key: string): void {
    const tabs = this.state.terminalTabs;
    const i = tabs.findIndex((x) => x.key === key);
    if (i < 0) return;
    const rest = tabs.filter((x) => x.key !== key);
    const active =
      this.state.terminalActive === key
        ? (rest[Math.min(i, rest.length - 1)]?.key ?? null)
        : this.state.terminalActive;
    this.set({ terminalTabs: rest, terminalActive: active });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function same(a: AXTask[], b: AXTask[]): boolean {
  return (
    a.length === b.length &&
    a.every((t, i) => JSON.stringify(t) === JSON.stringify(b[i]))
  );
}

async function kubeContexts(repoExpanded: string): Promise<{
  contexts: AXContext[];
  kindKubeconfigs: Record<string, string>;
}> {
  const [names, current, kindClusters] = await Promise.all([
    window.studio.run({
      program: "kubectl",
      args: ["config", "get-contexts", "-o", "name"],
    }),
    window.studio.run({
      program: "kubectl",
      args: ["config", "current-context"],
    }),
    window.studio.run({
      program: "kind",
      args: ["get", "clusters"],
    }),
  ]);
  const cur = result(current).ok ? result(current).stdout.trim() : "";
  const r = result(names);
  const seen = new Set<string>();
  const contexts: AXContext[] = [];
  if (r.ok) {
    for (const raw of r.stdout.split("\n")) {
      const name = raw.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      contexts.push({
        name,
        description: "Kubernetes context",
        isCurrent: name === cur,
      });
    }
  }
  const kindKubeconfigs: Record<string, string> = {};
  const kindRes = result(kindClusters);
  if (kindRes.ok) {
    const clusterNames = kindRes.stdout
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => isSafeResourceName(n) && !n.includes("/"));
    await Promise.all(
      clusterNames.map(async (cluster) => {
        const ctxName = `kind-${cluster}`;
        const candidateKc = `${repoExpanded}/.tmp/kubeconfig-${cluster}`;
        if (await window.studio.fileExists(candidateKc)) {
          kindKubeconfigs[ctxName] = candidateKc;
        }
        if (!seen.has(ctxName)) {
          seen.add(ctxName);
          contexts.push({
            name: ctxName,
            description: `Kind cluster (${cluster})`,
            isCurrent: !cur && contexts.length === 0,
          });
        }
      }),
    );
  }
  return { contexts, kindKubeconfigs };
}

export const store = new Store();
