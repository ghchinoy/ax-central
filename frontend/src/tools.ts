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

import { type ClustersStore, preflightBlocks } from "./model/clusters";
import {
  TEMPLATES,
  canApply,
  type DesignerStore,
  generate,
  issues,
  type Template,
  withID,
} from "./model/designer";
import { moveTask } from "./model/move";
import { isSafeResourceName, shortImage } from "./model/resources";
import {
  DEFAULT_SECRET_NAMESPACE,
  probeCredentialSecret,
} from "./model/secrets";
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
    "prompt_agent",
    "suspend_task",
    "resume_task",
    "move_task",
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
    "list_image_registries",
    "save_image_registry",
    "remove_image_registry",
    "resolve_image_digest",
    "list_clusters",
    "preflight_cluster_install",
    "check_credential_secret",
    "manage_local_stack",
    "run_hero_demo",
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
    name: "prompt_agent",
    description:
      "Send an A2A JSON-RPC message/send prompt (with W3C traceparent correlation) to an agent task. Automatically wakes Suspended tasks when wake_if_suspended is true.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Name of the target agent task." },
        prompt: {
          type: "string",
          description: "Natural-language prompt message to send to the agent.",
        },
        context_id: {
          type: "string",
          description:
            'Optional A2A session contextId (defaults to "hero-demo-session").',
        },
        wake_if_suspended: {
          type: "boolean",
          description:
            "Whether to resume the task first if it is currently Suspended (defaults to true).",
        },
        suspend_after: {
          type: "boolean",
          description:
            "Whether to suspend the task back to scale-to-zero once the A2A turn finishes (defaults to false).",
        },
      },
      ["name", "prompt"],
    ),
    consequential: true,
    async execute(args, ctx) {
      const name = reqSafeName(args, "name");
      const prompt = reqStr(args, "prompt");
      const task = ctx.store.state.tasks.find(
        (t) => t.name === name || t.id === name,
      );
      if (!task) {
        throw new ToolError(`Task "${name}" not found.`);
      }
      const contextId =
        typeof args.context_id === "string" && args.context_id.trim()
          ? args.context_id.trim()
          : "hero-demo-session";
      const wakeIfSuspended = args.wake_if_suspended !== false;
      const suspendAfter = Boolean(args.suspend_after);
      const res = await ctx.store.promptAgent(task, prompt, {
        contextId,
        wakeIfSuspended,
        suspendAfter,
      });
      if (!res.ok) {
        throw new ToolError(res.error || "A2A prompt failed.");
      }
      return {
        result: {
          task: task.name,
          ok: res.ok,
          reply: res.reply,
          trace_id: res.traceId,
          context_id: res.contextId,
        },
      };
    },
  },
  {
    name: "move_task",
    description:
      "Move an AX task and its /workspace files (via tar over ax ssh) to another context or atespace. Requires spec.debug: true on the task.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Name of the task to move." },
        target_context: {
          type: "string",
          description:
            "Destination context name (defaults to the current context).",
        },
        target_atespace: {
          type: "string",
          description:
            'Destination atespace name (defaults to the current atespace, or "staging" when moving within the same context).',
        },
        delete_original: {
          type: "boolean",
          description:
            "Whether to delete the original task after copying /workspace (defaults to false, which suspends the original).",
        },
        overwrite_existing: {
          type: "boolean",
          description:
            "Whether to delete and replace an existing task of the same name at the destination (defaults to false).",
        },
      },
      ["name"],
    ),
    consequential: true,
    async execute(args, ctx) {
      const name = reqSafeName(args, "name");
      const s = ctx.store.state;
      const task = s.tasks.find((t) => t.name === name || t.id === name);
      if (!task) {
        throw new ToolError(`Task "${name}" not found in ${s.atespace}.`);
      }
      const targetContext =
        typeof args.target_context === "string" && args.target_context.trim()
          ? reqSafeName(args, "target_context")
          : s.context;
      const targetAtespace =
        typeof args.target_atespace === "string" && args.target_atespace.trim()
          ? reqSafeName(args, "target_atespace")
          : s.atespace;
      const deleteOriginal = Boolean(args.delete_original);
      const overwriteExisting = Boolean(args.overwrite_existing);
      let lastSteps: { title: string; state: string; detail?: string }[] = [];
      const ok = await moveTask(
        task,
        {
          context: targetContext,
          atespace: targetAtespace,
          overwriteExisting,
        },
        deleteOriginal,
        (steps) => {
          lastSteps = steps;
        },
      );
      if (!ok) {
        const failed = lastSteps.find((st) => st.state === "failed");
        throw new ToolError(
          failed?.detail || `Failed to move task "${task.name}".`,
        );
      }
      return {
        result: {
          moved: task.name,
          from_context: s.context,
          from_atespace: task.atespace,
          target_context: targetContext,
          target_atespace: targetAtespace,
          delete_original: deleteOriginal,
          ok: true,
        },
      };
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
            "Template ID: blank, simple, ate-local, hero-demo-starter, hero-demo-custom, genkit-apple-container, swarm-reviewer, antigravity-dgem-gate, antigravity, gemini, openai, claude-managed-agents, or github-actions.",
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
    name: "list_image_registries",
    description:
      "List all configured container image artifact registries (including built-in ghcr.io/ghchinoy/ax-images and ghcr.io/rakyll/ax-images catalogs and any user-configured registries).",
    inputSchema: obj({}),
    readOnly: true,
    async execute(_args, ctx) {
      return {
        result: {
          count: ctx.designer.registries.length,
          registries: ctx.designer.registries,
        },
      };
    },
  },
  {
    name: "save_image_registry",
    description:
      "Add or update a custom OCI / Artifact Registry repository in the AX Central image catalog.",
    inputSchema: obj(
      {
        prefix: {
          type: "string",
          description:
            'Registry repository prefix (e.g. "us-central1-docker.pkg.dev/my-project/ax-images" or "ghcr.io/org/ax-images").',
        },
        title: {
          type: "string",
          description: "Human-readable title for the registry.",
        },
        images: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              digest: { type: "string" },
              description: { type: "string" },
            },
            required: ["name"],
          },
          description: "Optional list of image entries in this registry.",
        },
      },
      ["prefix"],
    ),
    async execute(args, ctx) {
      const prefix = reqStr(args, "prefix").replace(/\/+$/, "");
      if (!isSafeResourceName(prefix.replace(/[:/]/g, "-"))) {
        throw new ToolError(`Invalid registry prefix "${prefix}".`);
      }
      const title =
        typeof args.title === "string" && args.title.trim()
          ? args.title.trim()
          : prefix;
      const rawImgs = Array.isArray(args.images) ? args.images : [];
      const images = rawImgs
        .filter(
          (x): x is Record<string, unknown> =>
            Boolean(x) && typeof x === "object",
        )
        .map((x) => ({
          name: String(x.name ?? "").trim(),
          ...(typeof x.digest === "string" && x.digest.trim()
            ? { digest: x.digest.trim() }
            : {}),
          ...(typeof x.description === "string" && x.description.trim()
            ? { description: x.description.trim() }
            : {}),
        }))
        .filter((x) => x.name && isSafeResourceName(x.name));
      const id = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
      const registries = ctx.designer.saveRegistry({
        id,
        title,
        prefix,
        images,
      });
      return {
        result: {
          saved: id,
          count: registries.length,
          registries,
        },
      };
    },
  },
  {
    name: "remove_image_registry",
    description:
      "Remove a custom image registry from the AX Central catalog by ID or prefix.",
    inputSchema: obj(
      {
        id: {
          type: "string",
          description: "Registry ID or prefix to remove.",
        },
      },
      ["id"],
    ),
    async execute(args, ctx) {
      const id = reqStr(args, "id");
      const registries = ctx.designer.removeRegistry(id);
      return {
        result: {
          removed: id,
          count: registries.length,
          registries,
        },
      };
    },
  },
  {
    name: "resolve_image_digest",
    description:
      "Resolve and pin the @sha256: manifest digest for a container image reference (and optionally update the Deploy draft image).",
    inputSchema: obj({
      image: {
        type: "string",
        description:
          "Image reference to resolve (defaults to the current Deploy draft image).",
      },
      update_draft: {
        type: "boolean",
        description:
          "Whether to update the current Deploy draft image with the resolved @sha256: reference (defaults to true).",
      },
    }),
    async execute(args, ctx) {
      const imageRef =
        typeof args.image === "string" && args.image.trim()
          ? args.image.trim()
          : ctx.designer.draft.image;
      const updateDraft = args.update_draft !== false;
      const res = await ctx.designer.resolveDigest(imageRef);
      if (!res.digest) {
        throw new ToolError(
          res.error || `Could not resolve digest for "${imageRef}".`,
        );
      }
      if (updateDraft) {
        ctx.designer.set({ image: res.resolved });
      }
      return {
        result: {
          image: imageRef,
          resolved: res.resolved,
          digest: res.digest,
          updated_draft: updateDraft,
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
    name: "preflight_cluster_install",
    description:
      "Check whether `ax install` can run on an existing (non-Kind) kubeconfig context: Kubernetes 1.36+ (1.37+ recommended), the PodCertificateRequest and ClusterTrustBundle APIs, an installed Agent Substrate (ate-system and ate.dev CRDs), a WorkerPool, the ax-server image, and an ax CLI with install support. Read-only.",
    inputSchema: obj(
      {
        context: {
          type: "string",
          description: "Kubeconfig context to check (from list_clusters).",
        },
      },
      ["context"],
    ),
    readOnly: true,
    async execute(args, ctx) {
      const context = reqSafeName(args, "context");
      if (!ctx.clusters.state.loaded) {
        await ctx.clusters.init();
      }
      const cl = ctx.clusters.state.clusters.find((c) => c.context === context);
      if (!cl) {
        throw new ToolError(
          `Unknown context "${context}". Call list_clusters for the available contexts.`,
        );
      }
      const checks = await ctx.clusters.preflightInstall(cl);
      return {
        result: {
          context,
          can_install: !preflightBlocks(checks),
          checks,
        },
      };
    },
  },
  {
    name: "check_credential_secret",
    description:
      "Check whether a Kubernetes Gateway credential Secret exists and contains the expected key (reads key names only; secret values never leave the cluster). Read-only.",
    inputSchema: obj(
      {
        name: {
          type: "string",
          description: "Kubernetes Secret name (RFC-1123 label).",
        },
        key: {
          type: "string",
          description: "Key name inside the Secret (e.g. api-key).",
        },
        namespace: {
          type: "string",
          description: `Kubernetes namespace (defaults to "${DEFAULT_SECRET_NAMESPACE}").`,
        },
        context: {
          type: "string",
          description:
            "Optional Kubernetes context (defaults to the active context).",
        },
      },
      ["name", "key"],
    ),
    readOnly: true,
    async execute(args, ctx) {
      const name = reqStr(args, "name");
      const key = reqStr(args, "key");
      const namespace =
        typeof args.namespace === "string" && args.namespace.trim()
          ? args.namespace.trim()
          : DEFAULT_SECRET_NAMESPACE;
      const context =
        typeof args.context === "string" && args.context.trim()
          ? args.context.trim()
          : ctx.store.state.context;
      const status = await probeCredentialSecret({
        context,
        namespace,
        name,
        key,
      });
      if (status.error) {
        throw new ToolError(status.error);
      }
      return {
        result: {
          context: status.context,
          namespace: status.namespace,
          name: status.name,
          key: status.key,
          exists: status.exists,
          has_key: status.hasKey,
          keys: status.keys,
          credential_uri: status.credentialUri,
          is_local: Boolean(status.isLocal),
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
          enum: [
            "status",
            "up",
            "down",
            "reset",
            "use",
            "multi-up",
            "multi-down",
            "use-b",
          ],
          description:
            "status (refresh state), up (start Cluster A), down (stop stack), reset (clean & restart), use (switch to local Cluster A :8090), multi-up (start Cluster A + Podman Cluster B :8091), multi-down (stop Cluster B), or use-b (switch to local-podman Cluster B :8091).",
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
      if (action === "use-b") {
        await ctx.clusters.openLocalClusterB();
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
      else if (action === "multi-up")
        ok = await ctx.clusters.localStackMultiUp();
      else if (action === "multi-down")
        ok = await ctx.clusters.localStackMultiDown();
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
    name: "run_hero_demo",
    description:
      "Execute the 5-step AX v0.1 Hero Demo (~/projects/ax-experiments/hero-demo/run-live.sh) across Cluster A & Cluster B and return the 5/5 PASS/STUB/FAIL scoreboard.",
    inputSchema: obj({
      attach: {
        type: "boolean",
        description:
          "Run against the active local-stack.sh multi-up (:8090 / :8091) so resources appear live in AX Central (defaults to true).",
      },
      keep_stack: {
        type: "boolean",
        description:
          "Keep stack and demo resources running after completion (defaults to true).",
      },
      step: {
        type: "number",
        description: "Optional single step number (1-5) to run.",
      },
    }),
    consequential: true,
    async execute(args, ctx) {
      const attach = args.attach !== false;
      const keepStack = args.keep_stack !== false;
      const step =
        typeof args.step === "number" && args.step >= 1 && args.step <= 5
          ? Math.round(args.step)
          : undefined;
      ctx.store.setSection("clusters");
      const out = await ctx.clusters.runHeroDemo({ attach, keepStack, step });
      await ctx.store.refresh(true);
      return {
        result: {
          ok: out.ok,
          passed: out.scoreboard.filter((s) => s.status === "pass").length,
          total: out.scoreboard.length,
          scoreboard: out.scoreboard,
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
