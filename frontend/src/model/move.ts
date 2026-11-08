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

import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { ensureStudioBridge } from "../bridge";
import {
  type AXTask,
  type Phase,
  errorSummary,
  isSafeResourceName,
  toPhase,
} from "./resources";
import { store } from "./store";

/**
 * Moving a task to another context or atespace. AX checkpoints only a task's
 * /workspace volume inside the storage backend of the cluster that created it,
 * so a move recreates the task at the destination and streams the workspace
 * across with tar over `ax ssh`. Running processes restart; files survive.
 */

export interface MoveTarget {
  context: string;
  atespace: string;
  clearUnpinnedImage?: boolean;
}

export type StepState = "pending" | "running" | "done" | "failed";
export interface MoveStep {
  title: string;
  state: StepState;
  detail?: string;
}

/** How long to wait for a task to reach a phase before giving up. */
const PHASE_TIMEOUT = 180_000;

export function isSafeWorkspacePath(p: string): boolean {
  return (
    p.length > 0 &&
    p.length <= 256 &&
    /^\/[a-zA-Z0-9._/-]*$/.test(p) &&
    !p.includes("..")
  );
}

async function axAt(
  context: string,
  atespace: string,
  args: string[],
  stdin?: string,
) {
  ensureStudioBridge();
  const r = await window.studio.run({
    program: store.axPathFor(context),
    args: [...store.scopeFor(context, atespace), ...args],
    stdin,
    env: store.envFor(context),
  });
  return { ...r, ok: r.status === 0, error: errorSummary(r.stdout, r.stderr) };
}

async function mustAt(
  context: string,
  atespace: string,
  args: string[],
  stdin?: string,
): Promise<string> {
  const r = await axAt(context, atespace, args, stdin);
  if (!r.ok) throw new Error(r.error);
  return r.stdout;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A resource as fetched from one place, ready to apply in another. */
export function portable(text: string, to: MoveTarget): string {
  const doc: any = parseYAML(text) ?? {};
  delete doc.status;
  if (doc.metadata) {
    delete doc.metadata.createTime;
    delete doc.metadata.uid;
    delete doc.metadata.resourceVersion;
    delete doc.metadata.generation;
    delete doc.metadata.managedFields;
    doc.metadata.atespace = to.atespace || "default";
  }
  if (
    doc.kind === "Task" &&
    to.context !== "local" &&
    (to.clearUnpinnedImage ?? true) &&
    typeof doc.spec?.image === "string" &&
    !doc.spec.image.includes("@sha256:")
  ) {
    delete doc.spec.image;
  }
  return stringifyYAML(doc);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function phaseOf(
  context: string,
  atespace: string,
  name: string,
): Promise<Phase> {
  const raw = await mustAt(context, atespace, ["get", "task", name]);
  const doc = parseYAML(raw) as { status?: { phase?: string } } | null;
  return toPhase(doc?.status?.phase);
}

async function waitFor(
  context: string,
  atespace: string,
  name: string,
  want: Phase,
): Promise<void> {
  const deadline = Date.now() + PHASE_TIMEOUT;
  for (;;) {
    const p = await phaseOf(context, atespace, name);
    if (p === want) return;
    if (p === "failed") throw new Error(`${name} failed`);
    if (Date.now() > deadline) {
      throw new Error(`${name} is still ${p} after ${PHASE_TIMEOUT / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function ensureRunning(
  context: string,
  atespace: string,
  name: string,
): Promise<void> {
  const p = await phaseOf(context, atespace, name);
  if (p === "running") return;
  if (p !== "pending") {
    await mustAt(context, atespace, ["resume", "task", name]);
  }
  await waitFor(context, atespace, name, "running");
}

export function moveSteps(
  to: MoveTarget,
  deleteOriginal: boolean,
  path = "/workspace",
): MoveStep[] {
  return [
    { title: "Read the task and its workspace", state: "pending" },
    {
      title: `Create it in ${to.context || "local"} / ${to.atespace || "default"}`,
      state: "pending",
    },
    { title: "Start both copies", state: "pending" },
    { title: `Copy ${path}`, state: "pending" },
    { title: "Restart the new copy on the copied files", state: "pending" },
    {
      title: deleteOriginal ? "Delete the original" : "Suspend the original",
      state: "pending",
    },
  ];
}

/**
 * Moves `t` from the current scope to `to`, reporting each step.
 * Resolves to whether it finished.
 */
export async function moveTask(
  t: AXTask,
  to: MoveTarget,
  deleteOriginal: boolean,
  onProgress: (steps: MoveStep[]) => void,
): Promise<boolean> {
  const fromContext = store.state.context || "local";
  const fromAtespace = t.atespace || store.state.atespace || "default";
  const destContext = to.context || fromContext;
  const destAtespace = to.atespace || "default";
  const target: MoveTarget = {
    context: destContext,
    atespace: destAtespace,
    clearUnpinnedImage: to.clearUnpinnedImage,
  };

  let steps = moveSteps(target, deleteOriginal);
  let current = 0;
  const update = (i: number, state: StepState, detail?: string) => {
    steps = steps.map((s, j) =>
      j === i ? { ...s, state, detail: detail ?? s.detail } : s,
    );
    onProgress(steps);
  };
  const step = async <T>(i: number, fn: () => Promise<T>) => {
    current = i;
    update(i, "running");
    const v = await fn();
    update(i, "done");
    return v;
  };
  let created = false;
  try {
    if (
      !isSafeResourceName(t.name) ||
      !isSafeResourceName(fromContext) ||
      !isSafeResourceName(fromAtespace) ||
      !isSafeResourceName(destContext) ||
      !isSafeResourceName(destAtespace)
    ) {
      throw new Error("Invalid task, context, or atespace identifier.");
    }
    if (fromContext === destContext && fromAtespace === destAtespace) {
      throw new Error("Source and destination scope are identical.");
    }

    const { manifests, path, reused } = await step(0, async () => {
      const taskRaw = await mustAt(fromContext, fromAtespace, [
        "get",
        "task",
        t.name,
      ]);
      const task = parseYAML(taskRaw) as {
        spec?: {
          debug?: boolean;
          workspace?: { name?: string; path?: string };
        };
      } | null;
      if (!task?.spec?.debug) {
        throw new Error(
          "Moving copies files over ax ssh, which needs spec.debug: true on the task.",
        );
      }
      const rawPath = String(task.spec.workspace?.path || "/workspace");
      if (!isSafeWorkspacePath(rawPath)) {
        throw new Error(`Unsafe workspace path "${rawPath}"`);
      }
      const docs = [portable(stringifyYAML(task), target)];
      const ws = task.spec.workspace?.name;
      let wsReused = false;
      if (ws) {
        if (!isSafeResourceName(ws)) {
          throw new Error(`Invalid workspace identifier "${ws}"`);
        }
        if (
          (await axAt(destContext, destAtespace, ["get", "workspace", ws])).ok
        ) {
          wsReused = true;
        } else {
          const wsRaw = await mustAt(fromContext, fromAtespace, [
            "get",
            "workspace",
            ws,
          ]);
          docs.unshift(portable(wsRaw, target));
        }
      }
      return {
        manifests: docs.join("---\n"),
        path: rawPath,
        reused: wsReused,
      };
    });

    // Now that the workspace path is known, name it in the copy step.
    steps = moveSteps(target, deleteOriginal, path).map((s, i) =>
      i === 0 ? { ...s, state: "done" } : s,
    );
    onProgress(steps);

    await step(1, async () => {
      if ((await axAt(destContext, destAtespace, ["get", "task", t.name])).ok) {
        throw new Error(`A task named ${t.name} already exists there.`);
      }
      await mustAt(destContext, destAtespace, ["apply", "-f", "-"], manifests);
      created = true;
      if (reused) update(1, "running", "Uses the workspace already there");
    });

    await step(2, async () => {
      await ensureRunning(fromContext, fromAtespace, t.name);
      await ensureRunning(destContext, destAtespace, t.name);
    });

    await step(3, async () => {
      const fromScope = store.scopeFor(fromContext, fromAtespace);
      const destScope = store.scopeFor(destContext, destAtespace);
      const r = await window.studio.pipe({
        program: store.state.settings.axPath,
        fromProgram: store.axPathFor(fromContext),
        fromEnv: store.envFor(fromContext),
        from: [
          ...fromScope,
          "ssh",
          t.name,
          "--",
          "tar",
          "cf",
          "-",
          "-C",
          path,
          ".",
        ],
        toProgram: store.axPathFor(destContext),
        toEnv: store.envFor(destContext),
        to: [
          ...destScope,
          "ssh",
          t.name,
          "--",
          "sh",
          "-c",
          'chmod -R u+w "$1" 2>/dev/null || true; exec tar xf - -C "$1"',
          "sh",
          path,
        ],
      });
      if (r.status !== 0) throw new Error(errorSummary(r.stdout, r.stderr));
    });

    // The command started on an empty workspace; restart it so it sees the files.
    await step(4, async () => {
      await mustAt(destContext, destAtespace, ["suspend", "task", t.name]);
      await waitFor(destContext, destAtespace, t.name, "suspended");
      await mustAt(destContext, destAtespace, ["resume", "task", t.name]);
    });

    await step(5, async () => {
      if (deleteOriginal) {
        await mustAt(fromContext, fromAtespace, ["delete", "task", t.name]);
      } else {
        await mustAt(fromContext, fromAtespace, ["suspend", "task", t.name]);
      }
    });

    store.log(`Move ${t.name}`, `to ${destContext} / ${destAtespace}`, true);
    await store.refresh(true);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    update(
      current,
      "failed",
      created
        ? `${msg} The new copy was left in place; delete it before retrying.`
        : msg,
    );
    store.log(`Move ${t.name}`, msg, false);
    await store.refresh(true);
    return false;
  }
}
