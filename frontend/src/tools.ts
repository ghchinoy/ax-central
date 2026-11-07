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

import type { ClustersStore } from "./model/clusters";
import {
  TEMPLATES,
  canApply,
  type DesignerStore,
  generate,
  issues,
  type Template,
  withID,
} from "./model/designer";
import { isSafeResourceName, shortImage } from "./model/resources";
import { SECTIONS, type Section, type Store } from "./model/store";
import { ToolError } from "./registry";

export interface ToolOutput {
  result: Record<string, unknown>;
}

export interface ToolContext {
  store: Store;
  designer: DesignerStore;
  clusters: ClustersStore;
  signal: AbortSignal;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  consequential?: boolean;
  untrusted?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = typeof args[key] === "string" ? args[key].trim() : "";
  if (!v) throw new ToolError(`${key} is required.`);
  return v;
}

/**
 * Validates resource/context/atespace identifiers passed via WebMCP tools to
 * prevent CLI argument injection (mcp-auditor §2: reject leading '-' or shell metacharacters).
 */
export function reqSafeName(
  args: Record<string, unknown>,
  key: string,
): string {
  const v = reqStr(args, key);
  if (!isSafeResourceName(v)) {
    throw new ToolError(
      `Invalid ${key} "${v}": must be a valid resource identifier and must not start with "-".`,
    );
  }
  return v;
}

export const TOOL_GROUPS: Record<string, string[]> = {
  Tasks: [
    "list_tasks",
    "get_task",
    "select_task",
    "suspend_task",
    "resume_task",
    "delete_task",
  ],
  "Workspaces & Scope": [
    "list_workspaces",
    "delete_workspace",
    "list_contexts",
    "switch_scope",
  ],
  "Deploy & Clusters": [
    "load_template",
    "get_draft_manifest",
    "apply_manifest",
    "list_clusters",
    "manage_local_stack",
    "check_prerequisites",
  ],
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_tasks",
    description:
      "List all AX tasks in the current context and atespace with their phase, workspace, image, worker IP, and age.",
    inputSchema: obj({}),
    readOnly: true,
    untrusted: true,
    async execute(_args, ctx) {
      const s = ctx.store.state;
      const tasks = s.tasks.map((t) => {
        const d = s.details[t.id];
        return {
          id: t.id,
          name: t.name,
          atespace: t.atespace,
          phase: t.phase,
          workspace: d?.workspace ?? null,
          image: d?.image ? shortImage(d.image) : null,
          worker_ip: t.workerIP ?? null,
          age: t.age,
          selected: s.selectedTaskID === t.id,
        };
      });
      return {
        result: {
          context: s.context,
          atespace: s.atespace,
          count: tasks.length,
          selected_task_id: s.selectedTaskID,
          tasks,
        },
      };
    },
  },
  {
    name: "get_task",
    description:
      "Get full details, conditions, resources, and YAML manifest for a task by name.",
    inputSchema: obj(
      {
        name: {
          type: "string",
          description: "Name of the task in the current atespace.",
        },
      },
      ["name"],
    ),
    readOnly: true,
    untrusted: true,
    async execute(args, ctx) {
      const name = reqSafeName(args, "name");
      const s = ctx.store.state;
      const task = s.tasks.find((t) => t.name === name || t.id === name);
      if (!task) {
        throw new ToolError(`Task "${name}" not found in ${s.atespace}.`);
      }
      const detail = s.details[task.id];
      return {
        result: {
          id: task.id,
          name: task.name,
          atespace: task.atespace,
          phase: task.phase,
          worker_ip: task.workerIP ?? null,
          actor: task.actor ?? null,
          age: task.age,
          workspace: detail?.workspace ?? null,
          image: detail?.image ?? null,
          command: detail?.command ?? [],
          cpu: detail?.cpu ?? null,
          memory: detail?.memory ?? null,
          debug: detail?.debug ?? false,
          conditions: detail?.conditions ?? [],
          manifest: detail?.manifest ?? "",
        },
      };
    },
  },
  {
    name: "select_task",
    description: "Select a task in the UI to open its slide-in inspector pane.",
    inputSchema: obj(
      {
        name: {
          type: "string",
          description:
            "Task name to select (or empty string to close inspector).",
        },
      },
      ["name"],
    ),
    async execute(args, ctx) {
      const raw = typeof args.name === "string" ? args.name.trim() : "";
      if (!raw) {
        ctx.store.set({ selectedTaskID: null });
        return { result: { selected: null } };
      }
      const name = reqSafeName(args, "name");
      const task = ctx.store.state.tasks.find(
        (t) => t.name === name || t.id === name,
      );
      if (!task) {
        throw new ToolError(
          `Task "${name}" not found in ${ctx.store.state.atespace}.`,
        );
      }
      ctx.store.set({ selectedTaskID: task.id });
      return {
        result: {
          selected: task.id,
          name: task.name,
          phase: task.phase,
        },
      };
    },
  },
  {
    name: "suspend_task",
    description: "Suspend a running or pending AX task.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Name of the task to suspend." },
      },
      ["name"],
    ),
    consequential: true,
    async execute(args, ctx) {
      const name = reqSafeName(args, "name");
      const task = ctx.store.state.tasks.find(
        (t) => t.name === name || t.id === name,
      );
      if (!task) {
        throw new ToolError(`Task "${name}" not found.`);
      }
      const r = await ctx.store.suspend(task);
      if (!r.ok) throw new ToolError(r.error);
      return { result: { suspended: task.name, ok: true } };
    },
  },
  {
    name: "resume_task",
    description: "Resume a suspended, failed, or completed AX task.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Name of the task to resume." },
      },
      ["name"],
    ),
    async execute(args, ctx) {
      const name = reqSafeName(args, "name");
      const task = ctx.store.state.tasks.find(
        (t) => t.name === name || t.id === name,
      );
      if (!task) {
        throw new ToolError(`Task "${name}" not found.`);
      }
      const r = await ctx.store.resume(task);
      if (!r.ok) throw new ToolError(r.error);
      return { result: { resumed: task.name, ok: true } };
    },
  },
  {
    name: "delete_task",
    description:
      "Delete an AX task and tear down its sandbox. Only call when explicitly requested by the user.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Name of the task to delete." },
      },
      ["name"],
    ),
    consequential: true,
    async execute(args, ctx) {
      const name = reqSafeName(args, "name");
      const task = ctx.store.state.tasks.find(
        (t) => t.name === name || t.id === name,
      );
      const targetName = task ? task.name : name;
      if (task && ctx.store.state.selectedTaskID === task.id) {
        ctx.store.set({ selectedTaskID: null });
      }
      const r = await ctx.store.remove("task", targetName);
      if (!r.ok) throw new ToolError(r.error);
      return { result: { deleted: targetName, ok: true } };
    },
  },
  {
    name: "list_workspaces",
    description:
      "List all AX workspaces in the current atespace with their git repositories, MCP servers, files, and using tasks.",
    inputSchema: obj({}),
    readOnly: true,
    untrusted: true,
    async execute(_args, ctx) {
      const s = ctx.store.state;
      const workspaces = s.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        atespace: w.atespace,
        repos: w.repos,
        mcp_servers: w.mcpServers,
        files: w.files,
        tasks: ctx.store.tasksUsing(w.name).map((t) => t.name),
      }));
      return {
        result: {
          atespace: s.atespace,
          count: workspaces.length,
          workspaces,
        },
      };
    },
  },
  {
    name: "delete_workspace",
    description:
      "Delete an AX workspace from the current atespace. Only call when explicitly requested by the user.",
    inputSchema: obj(
      {
        name: {
          type: "string",
          description: "Name of the workspace to delete.",
        },
      },
      ["name"],
    ),
    consequential: true,
    async execute(args, ctx) {
      const name = reqSafeName(args, "name");
      const r = await ctx.store.remove("workspace", name);
      if (!r.ok) throw new ToolError(r.error);
      return { result: { deleted: name, ok: true } };
    },
  },
  {
    name: "list_contexts",
    description:
      "List available AX / Kubernetes contexts, the active context, and the active atespace.",
    inputSchema: obj({}),
    readOnly: true,
    async execute(_args, ctx) {
      const s = ctx.store.state;
      return {
        result: {
          current_context: s.context,
          atespace: s.atespace,
          section: s.section,
          contexts: s.contexts,
        },
      };
    },
  },
  {
    name: "switch_scope",
    description:
      "Switch AX Central to a different context, atespace, or UI section (overview, topology, designer, terminal, clusters).",
    inputSchema: obj({
      context: {
        type: "string",
        description: "Optional context name from list_contexts.",
      },
      atespace: {
        type: "string",
        description: 'Optional atespace name (e.g. "default").',
      },
      section: {
        type: "string",
        enum: [...SECTIONS],
        description: "Optional UI section to display.",
      },
    }),
    async execute(args, ctx) {
      const context =
        typeof args.context === "string" && args.context.trim()
          ? reqSafeName(args, "context")
          : undefined;
      const atespace =
        typeof args.atespace === "string" && args.atespace.trim()
          ? reqSafeName(args, "atespace")
          : undefined;
      const section =
        typeof args.section === "string" &&
        SECTIONS.includes(args.section as Section)
          ? (args.section as Section)
          : undefined;
      if (context || atespace) {
        ctx.store.setScope({
          ...(context ? { context } : {}),
          ...(atespace ? { atespace } : {}),
        });
      }
      if (section) {
        ctx.store.setSection(section);
      }
      return {
        result: {
          context: ctx.store.state.context,
          atespace: ctx.store.state.atespace,
          section: ctx.store.state.section,
        },
      };
    },
  },
  {
    name: "load_template",
    description:
      "Load a task template into the Deploy designer and open the Deploy view.",
    inputSchema: obj(
      {
        template: {
          type: "string",
          enum: TEMPLATES.map((t) => t.id),
          description:
            "Template ID: blank, simple, ate-local, genkit-apple-container, swarm-reviewer, gemini, openai, claude-managed-agents, or github-actions.",
        },
      },
      ["template"],
    ),
    async execute(args, ctx) {
      const id = reqStr(args, "template") as Template;
      if (!TEMPLATES.some((t) => t.id === id)) {
        throw new ToolError(
          `Unknown template "${id}". Valid templates: ${TEMPLATES.map((t) => t.id).join(", ")}`,
        );
      }
      ctx.designer.load(id);
      ctx.store.setSection("designer");
      return {
        result: {
          template: id,
          task_name: ctx.designer.draft.name,
          manifest: generate(ctx.designer.draft, true),
        },
      };
    },
  },
  {
    name: "get_draft_manifest",
    description:
      "Return the current YAML manifest in the Deploy designer (with secrets redacted) and any validation issues.",
    inputSchema: obj({}),
    readOnly: true,
    async execute(_args, ctx) {
      const d = ctx.designer.draft;
      return {
        result: {
          task_name: d.name,
          can_apply: canApply(d),
          issues: issues(d),
          manifest: generate(d, true),
        },
      };
    },
  },
  {
    name: "apply_manifest",
    description:
      "Apply either the provided YAML manifest or the current Deploy designer draft via `ax apply -f -`.",
    inputSchema: obj({
      yaml: {
        type: "string",
        description:
          "Optional raw YAML manifest to apply. If omitted, applies the current Deploy designer draft.",
      },
    }),
    consequential: true,
    async execute(args, ctx) {
      const raw =
        typeof args.yaml === "string" && args.yaml.trim()
          ? args.yaml
          : undefined;
      if (!raw && !canApply(ctx.designer.draft)) {
        const errs = issues(ctx.designer.draft)
          .filter((i) => i.severity === "error")
          .map((i) => i.text)
          .join("; ");
        throw new ToolError(`Draft has validation errors: ${errs}`);
      }
      const yamlToApply = raw ?? generate(ctx.designer.draft);
      const r = await ctx.store.apply(yamlToApply);
      if (!r.ok) throw new ToolError(r.error);
      if (!raw && !ctx.designer.draft.rawMode) {
        ctx.designer.set({ name: withID(ctx.designer.draft.name) });
      }
      return {
        result: {
          applied: true,
          output: r.stdout.trim() || "Created",
        },
      };
    },
  },
  {
    name: "list_clusters",
    description:
      "List local Apple Container (ate-local) stack status and kind clusters with their Kubernetes, Agent Substrate, and AX control-plane readiness.",
    inputSchema: obj({}),
    readOnly: true,
    async execute(_args, ctx) {
      if (!ctx.clusters.state.loaded) {
        await ctx.clusters.init();
      }
      const al = ctx.clusters.state.ateLocal;
      const status =
        al.axServer && al.ateLocal && al.postgres
          ? "running"
          : al.axServer || al.ateLocal || al.postgres
            ? "partial"
            : al.available
              ? "stopped"
              : "unavailable";
      return {
        result: {
          ate_local: {
            ...al,
            status,
            server_port: 8090,
            substrate_port: 50051,
            postgres_port: 5432,
            ax_server_ready: al.axServer,
            ate_local_ready: al.ateLocal,
            postgres_ready: al.postgres,
            microvms: al.actors,
          },
          runtime: ctx.clusters.state.runtime?.runtime ?? null,
          problems: ctx.clusters.problems,
          clusters: ctx.clusters.state.clusters,
        },
      };
    },
  },
  {
    name: "manage_local_stack",
    description:
      "Inspect or control the local macOS Apple Container (ate-local) stack (status, up, down, reset, or use).",
    inputSchema: obj(
      {
        action: {
          type: "string",
          enum: ["status", "up", "down", "reset", "use"],
          description:
            "status (refresh state), up (start stack), down (stop stack), reset (clean & restart), or use (switch AX Central to local context).",
        },
      },
      ["action"],
    ),
    consequential: true,
    async execute(args, ctx) {
      const action = reqStr(args, "action");
      if (action === "status") {
        await ctx.clusters.refresh();
        return { result: { ate_local: ctx.clusters.state.ateLocal } };
      }
      if (action === "use") {
        await ctx.clusters.openLocalStack();
        return {
          result: {
            context: ctx.store.state.context,
            atespace: ctx.store.state.atespace,
          },
        };
      }
      let ok = false;
      if (action === "up") ok = await ctx.clusters.localStackUp();
      else if (action === "down") ok = await ctx.clusters.localStackDown();
      else if (action === "reset") ok = await ctx.clusters.localStackReset();
      else throw new ToolError(`Unknown action "${action}".`);
      const logTail = ctx.clusters.state.log.slice(-20).map((l) => l.text);
      return {
        result: {
          action,
          ok,
          ate_local: ctx.clusters.state.ateLocal,
          log_tail: logTail,
        },
      };
    },
  },
  {
    name: "check_prerequisites",
    description:
      "Audit all required and optional prerequisites and repo variants for AX Central (Go, Apple container runtime, ~/projects/ax ate-local branch & binaries, ~/projects/ax-experiments & ax-agent-local image, Kind & Docker/Podman).",
    inputSchema: obj({}),
    readOnly: true,
    async execute(_args, ctx) {
      if (!ctx.clusters.state.loaded) {
        await ctx.clusters.init();
      } else {
        await ctx.clusters.refresh();
      }
      const checks = ctx.clusters.state.doctor;
      return {
        result: {
          all_ok: checks.every((c) => c.status === "ok"),
          ate_local_ready: checks
            .filter((c) => c.tier === "core" || c.tier === "ate-local")
            .every((c) => c.status === "ok"),
          checks,
        },
      };
    },
  },
];
