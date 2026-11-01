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

import type { ToolContext, ToolDef } from "./tools";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown> | string;
  window?: Window;
  origin?: string;
}

export interface ModelContextLike extends EventTarget {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      annotations?: {
        readOnlyHint?: boolean;
        consequentialHint?: boolean;
        untrustedContentHint?: boolean;
      };
      execute: (
        input: Record<string, unknown> | string,
        options?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<void> | void;
  getTools(): Promise<RegisteredTool[]>;
  executeTool(
    tool: RegisteredTool,
    input: Record<string, unknown> | string,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
}

/** document.modelContext when the browser implements WebMCP, else null. */
export function nativeModelContext(
  doc: Document = document,
): ModelContextLike | null {
  const mc = (doc as unknown as { modelContext?: ModelContextLike })
    .modelContext;
  return mc &&
    typeof mc.registerTool === "function" &&
    typeof mc.getTools === "function" &&
    typeof mc.executeTool === "function"
    ? mc
    : null;
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export type ToolResult = Record<string, unknown>;

export type Caller = "app" | "external";

export class ToolCallEvent extends Event {
  readonly caller: Caller;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: ToolResult;
  readonly ms: number;
  constructor(
    caller: Caller,
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ms: number,
  ) {
    super("call");
    this.caller = caller;
    this.name = name;
    this.args = args;
    this.result = result;
    this.ms = ms;
  }
}

export interface WebmcpDiagnostics {
  schemaType: string;
  argsForm: "object" | "string" | null;
  firstError: string;
  dropped: string[];
  conflicts: string[];
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

export function annotationsFor(def: ToolDef):
  | {
      readOnlyHint?: boolean;
      consequentialHint?: boolean;
      untrustedContentHint?: boolean;
    }
  | undefined {
  const a = {
    ...(def.readOnly ? { readOnlyHint: true } : {}),
    ...(def.consequential ? { consequentialHint: true } : {}),
    ...(def.untrusted ? { untrustedContentHint: true } : {}),
  };
  return Object.keys(a).length ? a : undefined;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const PARSE_ERROR = /parse input arguments|not of type 'object'/i;

export class ToolHost extends EventTarget {
  readonly mode: "webmcp" | "fallback";
  private readonly mc: ModelContextLike | null;
  private readonly defs = new Map<string, ToolDef>();
  private readonly registrations = new Map<string, AbortController>();
  private readonly makeContext: (signal: AbortSignal) => ToolContext;
  running = new Set<string>();
  externalCalls = 0;
  private readonly pendingOwn = new Map<string, { caller: Caller }[]>();
  readonly diagnostics: WebmcpDiagnostics = {
    schemaType: "",
    argsForm: null,
    firstError: "",
    dropped: [],
    conflicts: [],
  };

  constructor(
    makeContext: (signal: AbortSignal) => ToolContext,
    mc: ModelContextLike | null = nativeModelContext(),
  ) {
    super();
    this.mc = mc;
    this.mode = mc ? "webmcp" : "fallback";
    this.makeContext = makeContext;
    mc?.addEventListener("toolchange", () =>
      this.dispatchEvent(new Event("change")),
    );
  }

  async register(defs: ToolDef[]): Promise<void> {
    for (const def of defs) {
      if (this.registrations.has(def.name)) continue;
      const ac = new AbortController();
      this.defs.set(def.name, def);
      this.registrations.set(def.name, ac);
      if (this.mc) {
        try {
          await this.mc.registerTool(
            {
              name: def.name,
              description: def.description,
              inputSchema: def.inputSchema,
              annotations: annotationsFor(def),
              execute: (input, options) =>
                this.run(
                  def,
                  input === undefined || input === null
                    ? {}
                    : (asObject(input) ?? (input as Record<string, unknown>)),
                  options?.signal ?? new AbortController().signal,
                  this.pendingOwn.get(def.name)?.shift()?.caller ?? "external",
                ),
            },
            { signal: ac.signal },
          );
          this.diagnostics.conflicts = this.diagnostics.conflicts.filter(
            (c) => !c.startsWith(`${def.name}:`),
          );
        } catch (err) {
          this.registrations.delete(def.name);
          this.defs.delete(def.name);
          const why =
            err instanceof Error ? err.message || err.name : String(err);
          this.diagnostics.conflicts.push(`${def.name}: ${why}`);
          console.error(`registerTool(${def.name}) failed`, err);
        }
      }
    }
    if (!this.mc) this.dispatchEvent(new Event("change"));
    else if (this.diagnostics.conflicts.length)
      this.dispatchEvent(new Event("change"));
  }

  private isOurs(
    t: RegisteredTool,
    schema: Record<string, unknown> | undefined,
  ): boolean {
    const def = this.defs.get(t.name);
    return (
      !!def &&
      def.description === t.description &&
      canonicalJSON(def.inputSchema ?? null) === canonicalJSON(schema ?? null)
    );
  }

  unregister(names: string[]): void {
    for (const name of names) {
      this.registrations.get(name)?.abort();
      this.registrations.delete(name);
      this.defs.delete(name);
    }
    if (!this.mc) this.dispatchEvent(new Event("change"));
  }

  isRegistered(name: string): boolean {
    return this.registrations.has(name);
  }

  async list(): Promise<ToolInfo[]> {
    if (this.mc) {
      const tools = (await this.mc.getTools()).filter(
        (t) => !t.window || t.window === window,
      );
      if (tools.length)
        this.diagnostics.schemaType = typeof tools[0].inputSchema;
      const out: ToolInfo[] = [];
      this.diagnostics.dropped = [];
      for (const t of tools) {
        const info: ToolInfo = { name: t.name, description: t.description };
        if (t.inputSchema !== undefined && t.inputSchema !== "") {
          const schema = asObject(t.inputSchema);
          if (!schema) {
            this.diagnostics.dropped.push(`${t.name}: unparseable inputSchema`);
            continue;
          }
          info.inputSchema = schema;
        }
        if (!this.isOurs(t, info.inputSchema)) {
          this.diagnostics.dropped.push(
            `${t.name}: not registered by this app${this.defs.has(t.name) ? " (description or schema differs)" : ""}`,
          );
          continue;
        }
        out.push(info);
      }
      return out;
    }
    return [...this.defs.values()]
      .map((d) => ({
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    caller: Exclude<Caller, "external"> = "app",
  ): Promise<ToolResult> {
    const token = { caller };
    try {
      if (this.mc) {
        const tool = (await this.mc.getTools()).find(
          (t) => t.name === name && (!t.window || t.window === window),
        );
        if (!tool) return { error: `Tool ${name} is not available right now.` };
        const schema =
          tool.inputSchema === undefined || tool.inputSchema === ""
            ? undefined
            : (asObject(tool.inputSchema) ?? undefined);
        if (!this.isOurs(tool, schema)) {
          return {
            error: `Tool ${name} on this page was not registered by this app; refusing to run it.`,
          };
        }
        const queue = this.pendingOwn.get(name) ?? [];
        queue.push(token);
        this.pendingOwn.set(name, queue);
        return parseResult(await this.execute(tool, args, signal));
      }
      const def = this.defs.get(name);
      if (!def) return { error: `Tool ${name} is not available right now.` };
      return await this.run(def, args, signal, caller);
    } catch (err) {
      if (signal.aborted) return { error: "cancelled" };
      return { error: `Tool failed: ${(err as Error).message || String(err)}` };
    } finally {
      const queue = this.pendingOwn.get(name);
      const i = queue?.indexOf(token) ?? -1;
      if (queue && i >= 0) queue.splice(i, 1);
    }
  }

  private async execute(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string | null> {
    const mc = this.mc!;
    const d = this.diagnostics;
    const first =
      d.argsForm ??
      (typeof tool.inputSchema === "string" ? "string" : "object");
    const run = (form: "object" | "string") =>
      mc.executeTool(tool, form === "string" ? JSON.stringify(args) : args, {
        signal,
      });
    try {
      const r = await run(first);
      d.argsForm = first;
      return r;
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      if (d.argsForm !== null || signal.aborted || !PARSE_ERROR.test(msg)) {
        throw err;
      }
      d.firstError = `${first}: ${msg}`;
      const other = first === "string" ? "object" : "string";
      const r = await run(other);
      d.argsForm = other;
      return r;
    }
  }

  private async run(
    def: ToolDef,
    args: Record<string, unknown>,
    signal: AbortSignal,
    caller: Caller,
  ): Promise<ToolResult> {
    this.running.add(def.name);
    this.dispatchEvent(new Event("running"));
    if (caller === "external") this.externalCalls++;
    const started = performance.now();
    let result: ToolResult;
    try {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new ToolError("Arguments must be a JSON object.");
      }
      const out = await def.execute(args, this.makeContext(signal));
      result = signal.aborted ? { error: "cancelled" } : out.result;
    } catch (err) {
      if (signal.aborted) result = { error: "cancelled" };
      else if (err instanceof ToolError) result = { error: err.message };
      else {
        console.error(`tool ${def.name}`, err);
        result = {
          error: `Internal error in ${def.name}: ${(err as Error).message}`,
        };
      }
    } finally {
      this.running.delete(def.name);
      this.dispatchEvent(new Event("running"));
    }
    this.dispatchEvent(
      new ToolCallEvent(
        caller,
        def.name,
        args,
        result,
        Math.round(performance.now() - started),
      ),
    );
    return result;
  }
}

function parseResult(json: unknown): ToolResult {
  if (json === null || json === undefined || json === "") return {};
  if (typeof json === "object") {
    return Array.isArray(json) ? { result: json } : (json as ToolResult);
  }
  if (typeof json !== "string") return { result: json };
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as ToolResult)
      : { result: v };
  } catch {
    return { result: json };
  }
}
