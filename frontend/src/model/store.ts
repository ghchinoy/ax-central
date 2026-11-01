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
  parseContexts,
  parseModels,
  parseTaskYAML,
  parseTasks,
  parseWorkspaceYAML,
  parseWorkspaces,
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

export interface Settings {
  axPath: string;
  repoPath: string;
  experimentsPath: string;
  localServer: string;
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
  axVersion: string | null;
  axConfig: boolean;
  localAxBin: string | null;
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

function loadSettings(): Settings {
  const defaults: Settings = {
    axPath: "ax",
    repoPath: "~/projects/ax",
    experimentsPath: "~/projects/ax-experiments",
    localServer: "localhost:8090",
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
    axVersion: null,
    axConfig: true,
    localAxBin: null,
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
    this.timer = setTimeout(
      this.loop,
      Math.max(1.5, this.state.settings.refreshInterval) * 1000,
    );
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
    this.set({
      ...patch,
      tasks: [],
      workspaces: [],
      models: [],
      details: {},
      history: [],
      selectedTaskID: null,
      connectionError: null,
    });
    void this.refresh();
  }

  async loadContexts(): Promise<void> {
    ensureStudioBridge();
    const info = await window.studio.platform();
    const repoExpanded = this.state.settings.repoPath.replace(/^~/, info.home);
    const candidateLocalAx = `${repoExpanded}/.ax-local/bin/ax`;
    const hasLocalAx = await window.studio.fileExists(candidateLocalAx);
    this.set({ localAxBin: hasLocalAx ? candidateLocalAx : null });

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
    if (r.ok) {
      contexts = parseContexts(r.stdout);
      this.set({ axConfig: true });
    } else if (/unknown command/i.test(r.stderr + r.stdout)) {
      contexts = await kubeContexts();
      this.set({ axConfig: false });
    } else {
      contexts = [];
    }
    if (!contexts.some((c) => c.name === "local")) {
      contexts = [
        {
          name: "local",
          description: `Local Apple container (ate-local · ${this.state.settings.localServer})`,
          isCurrent: contexts.length === 0,
        },
        ...contexts,
      ];
    }
    const asked = new URLSearchParams(location.search).get("context");
    this.set({
      contexts,
      context:
        this.state.context ||
        asked ||
        contexts.find((c) => c.isCurrent)?.name ||
        "local",
    });
  }

  get effectiveAxPath(): string {
    if (
      this.state.context === "local" &&
      this.state.settings.axPath === "ax" &&
      this.state.localAxBin
    ) {
      return this.state.localAxBin;
    }
    return this.state.settings.axPath;
  }

  get scope(): string[] {
    const a: string[] = [];
    if (this.state.context === "local") {
      a.push("--server", this.state.settings.localServer || "localhost:8090");
    } else if (this.state.context) {
      a.push("--context", this.state.context);
    }
    a.push("-a", this.state.atespace || "default");
    return a;
  }

  get envForContext(): Record<string, string> | undefined {
    if (this.state.context === "local") {
      return { AX_SERVER: this.state.settings.localServer || "localhost:8090" };
    }
    return undefined;
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
      this.set({
        connectionError: null,
        tasks: same(tasks, this.state.tasks) ? this.state.tasks : tasks,
        ...this.takeAskedTask(tasks),
        workspaces,
        models: mr.ok ? parseModels(mr.stdout) : this.state.models,
        lastRefresh: Date.now(),
        history: [...this.state.history, { date: Date.now(), counts }].slice(
          -360,
        ),
      });
      await this.loadDetails();
    } finally {
      this.set({ isRefreshing: false });
    }
  }

  private async loadDetails(): Promise<void> {
    const tasks = this.state.tasks;
    const results = await Promise.all(
      tasks.map((t) => this.ax(["get", "task", t.name])),
    );
    const details: Record<string, TaskDetail> = {};
    tasks.forEach((t, i) => {
      const r = results[i];
      if (r.ok) details[t.id] = parseTaskYAML(r.stdout);
      else if (this.state.details[t.id])
        details[t.id] = this.state.details[t.id];
    });
    const wsResults = await Promise.all(
      this.state.workspaces.map((w) => this.ax(["get", "workspace", w.name])),
    );
    const workspaces = this.state.workspaces.map((w, i) =>
      wsResults[i]?.ok ? parseWorkspaceYAML(wsResults[i].stdout, w) : w,
    );
    this.set({ details, workspaces });
  }

  suspend = (t: AXTask) =>
    this.perform(`Suspend ${t.name}`, ["suspend", "task", t.name]);
  resume = (t: AXTask) =>
    this.perform(`Resume ${t.name}`, ["resume", "task", t.name]);
  remove = (kind: string, name: string) =>
    this.perform(`Delete ${kind} ${name}`, ["delete", kind, name]);
  apply = (yaml: string) =>
    this.perform("Apply manifest", ["apply", "-f", "-"], yaml);

  async resumeAll(tasks?: AXTask[]): Promise<void> {
    const targets =
      tasks ??
      this.state.tasks.filter(
        (t) =>
          t.phase === "suspended" ||
          t.phase === "failed" ||
          t.phase === "completed",
      );
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
    const targets =
      tasks ??
      this.state.tasks.filter(
        (t) => t.phase === "running" || t.phase === "pending",
      );
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
    if (!this.state.axConfig) return;
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

async function kubeContexts(): Promise<AXContext[]> {
  const [names, current] = await Promise.all([
    window.studio.run({
      program: "kubectl",
      args: ["config", "get-contexts", "-o", "name"],
    }),
    window.studio.run({
      program: "kubectl",
      args: ["config", "current-context"],
    }),
  ]);
  const cur = result(current).ok ? result(current).stdout.trim() : "";
  const r = result(names);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      description: "Kubernetes context",
      isCurrent: name === cur,
    }));
}

export const store = new Store();
