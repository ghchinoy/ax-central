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

import {
  css,
  html,
  LitElement,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { ensureStudioBridge } from "../bridge";
import { icon } from "../icons";
import type { AXTask } from "../model/resources";
import { store } from "../model/store";
import { sharedStyles } from "../shared-styles";

export type LogSource = "guest" | "substrate" | "otel" | "runsc";
export type LogFilter = "all" | "guest" | "substrate" | "otel";

export interface LogLine {
  id: number;
  time: string;
  text: string;
  source: LogSource;
  runner: boolean;
  traceID?: string;
  spanID?: string;
}

export interface TraceSpan {
  traceID: string;
  spanID: string;
  parentSpanID?: string;
  service: string;
  name: string;
  startNano: number;
  endNano: number;
  durationMs: number;
  status?: string;
}

export interface SandboxTelemetry {
  memoryWorkingSetMiB?: number;
  memoryPeakMiB?: number;
  cpuSec?: number;
  checkpointTotalMs?: number;
  checkpointFsMs?: number;
}

const MAX_LINES = 2000;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sanitizeContainerPart = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "-");
let streams = 0;

/** Parses slog text `key=value` and `key="quoted"` pairs from a log line. */
export function parseSlogFields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z0-9_.-]+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[m[1]] = val;
  }
  return out;
}

/** Parses Jaeger v2 OTLP `/api/v3/traces/<id>` JSON into flat TraceSpan items. */
export function parseJaegerTraceJSON(
  raw: string,
  fallbackTraceID: string,
): TraceSpan[] {
  let doc: {
    result?: {
      resourceSpans?: {
        resource?: {
          attributes?: { key?: string; value?: { stringValue?: string } }[];
        };
        scopeSpans?: {
          spans?: {
            traceId?: string;
            spanId?: string;
            parentSpanId?: string;
            name?: string;
            startTimeUnixNano?: string | number;
            endTimeUnixNano?: string | number;
          }[];
        }[];
      }[];
    };
  };
  try {
    doc = JSON.parse(raw) as typeof doc;
  } catch {
    return [];
  }
  const spans: TraceSpan[] = [];
  for (const rs of doc.result?.resourceSpans ?? []) {
    const svc =
      rs.resource?.attributes?.find((a) => a.key === "service.name")?.value
        ?.stringValue ?? "substrate";
    for (const ss of rs.scopeSpans ?? []) {
      for (const sp of ss.spans ?? []) {
        const startNano = Number(sp.startTimeUnixNano) || 0;
        const endNano = Number(sp.endTimeUnixNano) || startNano;
        const durationMs = Math.max(0, (endNano - startNano) / 1e6);
        spans.push({
          traceID: sp.traceId || fallbackTraceID,
          spanID: sp.spanId || "",
          parentSpanID: sp.parentSpanId || undefined,
          service: svc,
          name: sp.name || "span",
          startNano,
          endNano,
          durationMs,
        });
      }
    }
  }
  return spans.sort((a, b) => a.startNano - b.startNano);
}

@customElement("ax-task-logs")
export class AxTaskLogs extends LitElement {
  @property({ attribute: false }) task!: AXTask;
  @state() private lines: LogLine[] = [];
  @state() private filter: LogFilter = "all";
  @state() private showRunsc = false;
  @state() private status: "following" | "ended" | "failed" = "following";
  @state() private error = "";
  @state() private expanded =
    new URLSearchParams(location.search).get("logs") === "expanded";
  @state() private telemetry: SandboxTelemetry = {};
  @state() private genkitSpans = new Map<string, TraceSpan[]>();
  @state() private traceLabels = new Map<string, string>();
  @state() private selectedTraceID: string | null = null;
  @state() private loadedTraceSpans: TraceSpan[] = [];
  @state() private loadingTrace = false;
  @query(".task-logs") private box?: HTMLElement;

  private pinned = true;
  private cleanupStream: (() => void) | null = null;
  private offStore: (() => void) | null = null;
  private lastKey = "";

  override connectedCallback(): void {
    super.connectedCallback();
    this.offStore = store.subscribe(() => {
      this.syncStream();
      this.requestUpdate();
    });
    window.addEventListener("keydown", this.onKey);
    this.syncStream();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offStore?.();
    this.cleanupStream?.();
    window.removeEventListener("keydown", this.onKey);
  }

  override updated(changed: PropertyValues): void {
    if (changed.has("task")) {
      this.syncStream();
    }
    if (
      (changed.has("lines") || changed.has("expanded")) &&
      this.box &&
      this.pinned
    ) {
      this.box.scrollTop = this.box.scrollHeight;
    }
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.expanded && e.key === "Escape") {
      this.expanded = false;
    }
  };

  private recordGenkitSpan(fields: Record<string, string>): void {
    const traceID = fields.trace_id;
    if (!traceID) return;
    const spanName = fields.span || "genkit";
    const startNano = Number(fields.start_unix_nano) || Date.now() * 1e6;
    const durationMs = Number(fields.duration_ms) || 0;
    const endNano =
      Number(fields.end_unix_nano) || startNano + durationMs * 1e6;
    const sp: TraceSpan = {
      traceID,
      spanID: fields.span_id || `${startNano}`,
      parentSpanID: fields.parent_span_id || undefined,
      service: fields.agent ? `genkit:${fields.agent}` : "genkit",
      name: fields.subtype ? `${spanName} (${fields.subtype})` : spanName,
      startNano,
      endNano,
      durationMs,
      status: fields.status,
    };
    const existing = this.genkitSpans.get(traceID) ?? [];
    this.genkitSpans.set(
      traceID,
      [...existing, sp].sort((a, b) => a.startNano - b.startNano),
    );
    if (!this.traceLabels.has(traceID) || !fields.parent_span_id) {
      this.traceLabels.set(traceID, `Genkit · ${spanName}`);
    }
    if (this.selectedTraceID === traceID) {
      this.loadedTraceSpans = this.genkitSpans.get(traceID) ?? [];
    }
  }

  private async selectTrace(traceID: string): Promise<void> {
    if (this.selectedTraceID === traceID) {
      this.selectedTraceID = null;
      this.loadedTraceSpans = [];
      return;
    }
    this.selectedTraceID = traceID;
    const localSpans = this.genkitSpans.get(traceID) ?? [];
    this.loadedTraceSpans = localSpans;

    const ctx = store.state.context;
    if (!ctx || ctx === "local") return;

    this.loadingTrace = true;
    try {
      ensureStudioBridge();
      const args = [
        ...(ctx === "kube" ? [] : ["--context", ctx]),
        "-n",
        "otel-system",
        "exec",
        "deploy/jaeger",
        "--",
        "wget",
        "-qO-",
        `http://127.0.0.1:16686/api/v3/traces/${traceID}`,
      ];
      const res = await window.studio.run({
        program: "kubectl",
        args,
        env: store.envForContext,
      });
      if (this.selectedTraceID !== traceID) return;
      if (res.status === 0 && res.stdout.trim()) {
        const jaegerSpans = parseJaegerTraceJSON(res.stdout, traceID);
        // Filter out noisy low-level SQL tuple spans unless few spans exist
        const filtered =
          jaegerSpans.length > 12
            ? jaegerSpans.filter(
                (s) =>
                  !s.name.startsWith("SELECT ") &&
                  !s.name.startsWith("INSERT ") &&
                  !s.name.startsWith("UPDATE ") &&
                  !s.name.startsWith("postgres.") &&
                  !s.name.startsWith("sqlcommon.") &&
                  !s.name.startsWith("check") &&
                  s.name !== "union" &&
                  s.name !== "weight2" &&
                  s.name !== "defaultTTU" &&
                  s.name !== "ResolveCheck" &&
                  s.name !== "resolveTypesystem" &&
                  s.name !== "begin" &&
                  s.name !== "commit",
              )
            : jaegerSpans;
        const merged = [
          ...localSpans,
          ...(filtered.length ? filtered : jaegerSpans),
        ].sort((a, b) => a.startNano - b.startNano);
        this.loadedTraceSpans = merged;
      }
    } finally {
      if (this.selectedTraceID === traceID) {
        this.loadingTrace = false;
      }
    }
  }

  private syncStream(force = false): void {
    if (!this.task) return;
    const ctx = store.state.context;
    const isLocal = ctx === "local";
    const key = `${ctx}:${this.task.atespace}/${this.task.name}:${this.task.actor ?? ""}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;

    this.cleanupStream?.();
    this.cleanupStream = null;
    if (!ctx) return;

    ensureStudioBridge();
    this.lines = [];
    this.telemetry = {};
    this.genkitSpans = new Map();
    this.traceLabels = new Map();
    this.selectedTraceID = null;
    this.loadedTraceSpans = [];
    this.status = "following";
    this.error = "";

    const id = `task-logs-${++streams}`;
    let next = 1;
    let pending: LogLine[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;
    let other = "";
    const t = this.task;

    const pushLine = (
      rawText: string,
      time = "",
      source: LogSource = "guest",
      traceID?: string,
      spanID?: string,
    ) => {
      const text = rawText.replace(/\r/g, "");
      const isRunsc =
        source === "runsc" ||
        /^[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+ \S+\.go:\d+\]/.test(text);
      const fields = text.includes("=") ? parseSlogFields(text) : {};
      const resolvedTraceID =
        traceID ||
        (fields.trace_id &&
        fields.trace_id !== "00000000000000000000000000000000"
          ? fields.trace_id
          : undefined);
      const resolvedSpanID = spanID || fields.span_id;

      let effectiveSource: LogSource = isRunsc ? "runsc" : source;
      if (
        text.includes('msg="genkit otel span"') ||
        text.includes('msg="A2A turn ')
      ) {
        effectiveSource = "otel";
        if (text.includes('msg="genkit otel span"')) {
          this.recordGenkitSpan(fields);
        }
      }

      pending.push({
        id: next++,
        time,
        text,
        source: effectiveSource,
        runner:
          isRunsc ||
          effectiveSource === "substrate" ||
          /^time=\S+ level=\w+ msg=/.test(text),
        traceID: resolvedTraceID,
        spanID: resolvedSpanID,
      });
      flush ??= setTimeout(() => {
        const add = pending;
        pending = [];
        flush = null;
        this.lines = [...this.lines, ...add].slice(-MAX_LINES);
      }, 50);
    };

    const matchesActor = (
      atespace?: string,
      actorName?: string,
      templateName?: string,
    ): boolean => {
      if (atespace && atespace !== t.atespace) return false;
      return (
        actorName === t.name ||
        (!!t.actor && actorName === t.actor) ||
        (typeof templateName === "string" &&
          templateName.startsWith(`${t.name}-tmpl-`))
      );
    };

    const offLine = window.studio.onStreamLine((l) => {
      if (l.id !== id) return;
      if (isLocal) {
        try {
          const rec = JSON.parse(l.line) as {
            message?: string;
            time?: string;
            trace_id?: string;
            span_id?: string;
          };
          if (typeof rec?.message === "string") {
            pushLine(
              rec.message,
              rec.time ?? "",
              "guest",
              rec.trace_id,
              rec.span_id,
            );
            return;
          }
        } catch {
          // Raw container stdout/stderr line.
        }
        pushLine(l.line);
        return;
      }

      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(l.line) as Record<string, unknown>;
      } catch {
        if (/^error:|forbidden|not found|unable to/i.test(l.line))
          other = l.line;
        return;
      }

      const lab = rec.labels as Record<string, string> | undefined;
      if (lab) {
        if (
          !matchesActor(
            lab["ate.atespace"],
            lab["ate.actor.name"],
            lab["ate.template.name"],
          )
        ) {
          return;
        }
        const container = lab["ate.actor.container.name"];
        const msg = typeof rec.message === "string" ? rec.message : "";
        const time = typeof rec.time === "string" ? rec.time : "";
        const traceID =
          typeof rec.trace_id === "string" ? rec.trace_id : undefined;
        const spanID =
          typeof rec.span_id === "string" ? rec.span_id : undefined;

        if (container === "guest") {
          pushLine(msg, time, "guest", traceID, spanID);
        } else if (!container && msg) {
          if (traceID) this.traceLabels.set(traceID, `Substrate · ${msg}`);
          pushLine(`[substrate] ${msg}`, time, "substrate", traceID, spanID);
        }
        return;
      }

      // Top-level structured ateworker JSON log lines (usage, checkpoints, RPCs)
      const reqObj = rec.req as Record<string, unknown> | undefined;
      const atespace =
        (rec["ate.atespace"] as string | undefined) ??
        (reqObj?.atespace as string | undefined);
      const actorName =
        (rec["ate.actor.name"] as string | undefined) ??
        (reqObj?.actor_name as string | undefined);
      const templateName =
        (rec["ate.template.name"] as string | undefined) ??
        (reqObj?.actor_template_name as string | undefined);

      if (!matchesActor(atespace, actorName, templateName)) return;

      const msg = typeof rec.msg === "string" ? rec.msg : "";
      const time = typeof rec.time === "string" ? rec.time : "";
      const traceID =
        typeof rec.trace_id === "string" &&
        rec.trace_id !== "00000000000000000000000000000000"
          ? rec.trace_id
          : undefined;
      const spanID = typeof rec.span_id === "string" ? rec.span_id : undefined;

      if (msg === "Actor usage sampled") {
        const wsBytes = Number(rec["ate.stats.memory.working_set"]) || 0;
        const peakBytes = Number(rec["ate.stats.memory.peak"]) || 0;
        const cpuSec = Number(rec["ate.stats.cpu.time"]) || 0;
        const wsMiB = +(wsBytes / (1024 * 1024)).toFixed(1);
        const peakMiB = +(peakBytes / (1024 * 1024)).toFixed(1);
        this.telemetry = {
          ...this.telemetry,
          memoryWorkingSetMiB: wsMiB,
          memoryPeakMiB: peakMiB,
          cpuSec: +cpuSec.toFixed(2),
        };
        const kind = (rec["ate.stats.kind"] as string | undefined) ?? "sample";
        pushLine(
          `[substrate] Cgroup usage (${kind}): ${wsMiB} MiB RAM (peak ${peakMiB} MiB) · ${cpuSec.toFixed(2)}s CPU`,
          time,
          "substrate",
          traceID,
          spanID,
        );
      } else if (msg === "Checkpoint timing breakdown") {
        const totalSec =
          Number(rec["ateworker.actor.checkpoint.duration.total"]) || 0;
        const fsSec =
          Number(rec["ateworker.actor.checkpoint.duration.fs_checkpoint"]) || 0;
        const totalMs = +(totalSec * 1000).toFixed(1);
        const fsMs = +(fsSec * 1000).toFixed(1);
        this.telemetry = {
          ...this.telemetry,
          checkpointTotalMs: totalMs,
          checkpointFsMs: fsMs,
        };
        if (traceID)
          this.traceLabels.set(traceID, `Checkpoint (${totalMs} ms)`);
        pushLine(
          `[substrate] RustFS checkpoint completed in ${totalMs} ms (fs snapshot ${fsMs} ms)`,
          time,
          "substrate",
          traceID,
          spanID,
        );
      } else if (msg === "Handle RPC") {
        const method = typeof rec.method === "string" ? rec.method : "RPC";
        const elapsed =
          typeof rec["elapsed-time"] === "string"
            ? ` (${rec["elapsed-time"]})`
            : "";
        if (traceID && !this.traceLabels.has(traceID)) {
          this.traceLabels.set(
            traceID,
            `Substrate · ${method.split("/").pop() ?? method}`,
          );
        }
        pushLine(
          `[substrate] ${method}${elapsed}`,
          time,
          "substrate",
          traceID,
          spanID,
        );
      } else if (msg === "Actor has an egress policy") {
        pushLine(
          "[substrate] Actor egress policy active",
          time,
          "substrate",
          traceID,
          spanID,
        );
      }
    });

    const offExit = window.studio.onStreamExit((e) => {
      if (e.id !== id) return;
      if (flush) {
        clearTimeout(flush);
        const add = pending;
        pending = [];
        flush = null;
        if (add.length) this.lines = [...this.lines, ...add].slice(-MAX_LINES);
      }
      this.status = e.status === 0 ? "ended" : "failed";
      if (e.status !== 0)
        this.error =
          other ||
          `${isLocal ? "container logs" : "kubectl"} exited with status ${e.status}`;
    });

    if (isLocal) {
      const ates = sanitizeContainerPart(t.atespace);
      const c1 = shq(`ate-${ates}-${sanitizeContainerPart(t.actor || t.name)}`);
      const c2 = shq(`ate-${ates}-${sanitizeContainerPart(t.name)}`);
      const c3 = shq(`ax.${t.atespace}.${t.name}`);
      void window.studio.stream({
        id,
        commandLine: `if container inspect ${c1} >/dev/null 2>&1; then container logs -f ${c1} 2>&1; elif container inspect ${c2} >/dev/null 2>&1; then container logs -f ${c2} 2>&1; elif container inspect ${c3} >/dev/null 2>&1; then container logs -f ${c3} 2>&1; else printf 'Container %s is not running yet (phase: %s). Resume the task to stream guest logs.\\n' ${c1} ${shq(t.phase)}; fi`,
      });
    } else {
      const kc = `kubectl${ctx === "kube" ? "" : ` --context ${shq(ctx)}`}`;
      const namespaces = `$(${kc} get pods -A -l ate.dev/worker-pool -o jsonpath='{range .items[*]}{.metadata.namespace}{"\\n"}{end}' | sort -u)`;
      void window.studio.stream({
        id,
        commandLine: `for ns in ${namespaces}; do ${kc} -n "$ns" logs -l ate.dev/worker-pool --all-containers --prefix=false --ignore-errors -f --since=24h --tail=-1 --max-log-requests=50 2>&1 & done; wait`,
        env: store.envForContext,
      });
    }

    this.cleanupStream = () => {
      offLine();
      offExit();
      if (flush) clearTimeout(flush);
      void window.studio.cancelStream(id);
    };
  }

  private visibleLines(): LogLine[] {
    return this.lines.filter((l) => {
      if (l.source === "runsc" && !this.showRunsc) return false;
      if (this.filter === "all") return true;
      if (this.filter === "guest")
        return (
          l.source === "guest" || l.source === "otel" || l.source === "runsc"
        );
      if (this.filter === "substrate") return l.source === "substrate";
      if (this.filter === "otel")
        return l.source === "otel" || Boolean(l.traceID);
      return true;
    });
  }

  private renderLogLine = (l: LogLine): TemplateResult => {
    const cls =
      `task-log-line ${l.runner ? "runner" : ""} src-${l.source}`.trim();
    const text = l.text.replace(/\r/g, "") || " ";
    const tid = l.traceID;
    const label = tid ? `trace:${tid.slice(0, 7)}` : "";
    const pill = tid
      ? html` <button
          class="trace-pill ${this.selectedTraceID === tid ? "active" : ""}"
          title="Inspect OpenTelemetry trace ${tid}"
          @click=${() => void this.selectTrace(tid)}
        >
          ${label}
        </button>`
      : nothing;
    return html`<div class=${cls} title=${l.time}>${text}${pill}</div>`;
  };

  private renderTelemetryBar(): TemplateResult | typeof nothing {
    const tel = this.telemetry;
    const traceCount = this.traceLabels.size;
    if (
      tel.memoryWorkingSetMiB === undefined &&
      tel.checkpointTotalMs === undefined &&
      traceCount === 0
    ) {
      return nothing;
    }
    return html`
      <div class="row telemetry-strip caption">
        ${
          tel.memoryWorkingSetMiB !== undefined
            ? html`<span class="tel-chip" title="gVisor cgroup memory usage">
                <strong>${tel.memoryWorkingSetMiB} MiB</strong> RAM${
                  tel.memoryPeakMiB
                    ? html` <span class="faint"
                        >(peak ${tel.memoryPeakMiB} MiB)</span
                      >`
                    : nothing
                }
              </span>`
            : nothing
        }
        ${
          tel.cpuSec !== undefined
            ? html`<span class="tel-chip" title="gVisor cgroup CPU time">
                <strong>${tel.cpuSec}s</strong> CPU
              </span>`
            : nothing
        }
        ${
          tel.checkpointTotalMs !== undefined
            ? html`<span
                class="tel-chip"
                title="Last RustFS volume snapshot checkpoint duration"
              >
                <strong>${tel.checkpointTotalMs} ms</strong> checkpoint
              </span>`
            : nothing
        }
        ${
          traceCount > 0
            ? html`<span class="tel-chip" title="Captured OpenTelemetry traces">
                <strong>${traceCount}</strong>
                ${traceCount === 1 ? "trace" : "traces"}
              </span>`
            : nothing
        }
      </div>
    `;
  }

  private renderTraceWaterfall(): TemplateResult | typeof nothing {
    const traces = [...this.traceLabels.entries()];
    if (traces.length === 0 && !this.selectedTraceID) return nothing;

    const spans = this.loadedTraceSpans;
    const minStart = spans.length
      ? Math.min(...spans.map((s) => s.startNano))
      : 0;
    const maxEnd = spans.length
      ? Math.max(...spans.map((s) => s.endNano))
      : minStart + 1;
    const totalRange = Math.max(1, maxEnd - minStart);
    const totalMs = (totalRange / 1e6).toFixed(1);

    return html`
      <div class="trace-panel">
        <div class="row trace-chips">
          <span class="caption faint">OTel Traces:</span>
          ${traces
            .slice(-6)
            .map(
              ([tid, label]) => html`
                <button
                  class="trace-pill ${this.selectedTraceID === tid ? "active" : ""}"
                  title="${label} (${tid})"
                  @click=${() => void this.selectTrace(tid)}
                >
                  ${label} · ${tid.slice(0, 7)}
                </button>
              `,
            )}
        </div>
        ${
          this.selectedTraceID
            ? html`
                <div class="waterfall card">
                  <div class="row waterfall-head caption">
                    <strong class="mono"
                      >trace ${this.selectedTraceID.slice(0, 12)}…</strong
                    >
                    <span class="faint">
                      ${
                        this.loadingTrace
                          ? "loading Jaeger spans…"
                          : `${spans.length} ${spans.length === 1 ? "span" : "spans"} · ${totalMs} ms total`
                      }
                    </span>
                    <span class="spacer"></span>
                    <button
                      class="btn small ghost icon"
                      title="Close trace waterfall"
                      aria-label="Close trace waterfall"
                      @click=${() => {
                        this.selectedTraceID = null;
                        this.loadedTraceSpans = [];
                      }}
                    >
                      ${icon("x", 12)}
                    </button>
                  </div>
                  ${
                    spans.length === 0 && !this.loadingTrace
                      ? html`<div class="caption faint" style="padding:6px 0">
                          No span breakdown available for this trace ID.
                        </div>`
                      : html`
                          <div class="waterfall-rows">
                            ${spans.map((sp) => {
                              const leftPct = Math.max(
                                0,
                                Math.min(
                                  96,
                                  ((sp.startNano - minStart) / totalRange) *
                                    100,
                                ),
                              );
                              const widthPct = Math.max(
                                3,
                                Math.min(
                                  100 - leftPct,
                                  ((sp.endNano - sp.startNano) / totalRange) *
                                    100,
                                ),
                              );
                              return html`
                                <div
                                  class="wf-row"
                                  title="${sp.service} · ${sp.name} (${sp.durationMs.toFixed(2)} ms)"
                                >
                                  <span class="wf-svc mono">${sp.service}</span>
                                  <span class="wf-name ellipsis"
                                    >${sp.name}</span
                                  >
                                  <div class="wf-bar-track">
                                    <div
                                      class="wf-bar"
                                      style="left:${leftPct}%;width:${widthPct}%"
                                    ></div>
                                  </div>
                                  <span class="wf-dur mono"
                                    >${sp.durationMs.toFixed(1)}ms</span
                                  >
                                </div>
                              `;
                            })}
                          </div>
                        `
                  }
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  private renderBody() {
    const visible = this.visibleLines();
    const emptyText =
      this.status === "following"
        ? "Waiting for output…"
        : this.status === "failed"
          ? this.error
          : "No output in the last 24 hours.";
    const emptyLine = html`<span class="faint">${emptyText}</span>`;
    const hasRunsc = this.lines.some((l) => l.source === "runsc");

    return html`
      <div class="row log-filters">
        <div class="segmented" role="group" aria-label="Log source filter">
          ${(
            [
              ["all", "All"],
              ["guest", "Guest"],
              ["substrate", "Substrate"],
              ["otel", "OTel"],
            ] as const
          ).map(
            ([id, label]) => html`
              <button
                class=${this.filter === id ? "on" : ""}
                @click=${() => (this.filter = id)}
              >
                ${label}
              </button>
            `,
          )}
        </div>
        ${
          hasRunsc
            ? html`
                <button
                  class="btn small ghost ${this.showRunsc ? "active" : ""}"
                  title="Toggle low-level gVisor runsc boot logs"
                  @click=${() => (this.showRunsc = !this.showRunsc)}
                >
                  runsc
                </button>
              `
            : nothing
        }
      </div>
      ${this.renderTelemetryBar()}
      <div
        class="sandbox-output task-logs selectable"
        @scroll=${(e: Event) => {
          const el = e.currentTarget as HTMLElement;
          this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        ${visible.length === 0 ? emptyLine : visible.map(this.renderLogLine)}
      </div>
      ${this.renderTraceWaterfall()}
      <div class="row task-logs-foot caption faint">
        ${
          this.status === "following"
            ? html`<span class="pulse on" style="--c:var(--green)"></span>`
            : nothing
        }
        <span>
          ${
            this.status === "following"
              ? "Following"
              : this.status === "failed"
                ? "Stopped"
                : "Ended"
          }
          · ${visible.length} ${visible.length === 1 ? "line" : "lines"}
        </span>
        <span class="spacer"></span>
        ${
          visible.length > 0
            ? html`<button
                class="btn small ghost"
                @click=${() =>
                  void navigator.clipboard.writeText(
                    visible.map((l) => l.text).join("\n"),
                  )}
              >
                Copy
              </button>`
            : nothing
        }
        ${
          this.status !== "following"
            ? html`<button
                class="btn small ghost"
                @click=${() => this.syncStream(true)}
              >
                Reconnect
              </button>`
            : nothing
        }
        <button
          class="btn small ghost icon"
          title=${this.expanded ? "Collapse (Esc)" : "Expand"}
          aria-label=${this.expanded ? "Collapse logs" : "Expand logs"}
          @click=${() => (this.expanded = !this.expanded)}
        >
          ${icon(this.expanded ? "minimize" : "maximize", 13)}
        </button>
      </div>
    `;
  }

  override render() {
    if (!store.state.context) {
      return html`<p class="caption muted" style="margin:0">
        Select a context to view task logs.
      </p>`;
    }
    if (!this.expanded) return this.renderBody();
    return html`
      <p class="caption faint">Logs are open in a larger view.</p>
      <div
        class="modal-backdrop"
        @mousedown=${(e: MouseEvent) =>
          e.target === e.currentTarget && (this.expanded = false)}
      >
        <div class="card task-logs-modal">
          <div class="row task-logs-title">
            <strong>${this.task.name}</strong>
            <span class="faint">logs &amp; OTel traces</span>
          </div>
          ${this.renderBody()}
        </div>
      </div>
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .log-filters {
        gap: 6px;
        margin-bottom: 6px;
        flex-wrap: wrap;
      }
      .telemetry-strip {
        gap: 6px;
        flex-wrap: wrap;
        margin-bottom: 6px;
      }
      .tel-chip {
        padding: 2px 7px;
        border-radius: var(--radius-xs);
        background: var(--surface-container);
        border: 1px solid var(--border);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .sandbox-output {
        margin: 4px 0 0;
        padding: 10px;
        border-radius: var(--radius-s);
        max-height: 220px;
        overflow: auto;
        background: var(--console);
        color: var(--console-text);
        font-family: var(--font-mono);
        font-size: 11.5px;
      }
      .task-logs {
        min-height: 64px;
        max-height: 280px;
        line-height: 1.45;
      }
      .task-log-line {
        white-space: pre-wrap;
        word-break: break-all;
      }
      .task-logs .runner {
        color: #8d8d93;
      }
      .task-logs .src-otel {
        color: #78a9ff;
      }
      .task-logs .src-substrate {
        color: #be95ff;
      }
      .trace-pill {
        display: inline-flex;
        align-items: center;
        height: 15px;
        padding: 0 5px;
        margin-left: 4px;
        border-radius: 4px;
        border: 1px solid color-mix(in srgb, var(--primary) 40%, transparent);
        background: color-mix(in srgb, var(--primary) 14%, transparent);
        color: var(--primary);
        font-family: var(--font-mono);
        font-size: 9.5px;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        vertical-align: middle;
      }
      .trace-chips .trace-pill {
        height: 18px;
        padding: 0 6px;
        margin-left: 0;
        font-size: 10px;
      }
      .trace-pill:hover,
      .trace-pill.active {
        background: var(--primary);
        color: var(--on-primary);
      }
      .trace-panel {
        margin-top: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .trace-chips {
        gap: 5px;
        flex-wrap: wrap;
      }
      .waterfall {
        padding: 8px 10px;
        background: var(--surface-container);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .waterfall-head {
        gap: 8px;
      }
      .waterfall-rows {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 180px;
        overflow-y: auto;
      }
      .wf-row {
        display: grid;
        grid-template-columns: 92px minmax(90px, 1fr) 80px 48px;
        align-items: center;
        gap: 6px;
        font-size: 11px;
      }
      .wf-svc {
        font-size: 10px;
        color: var(--primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wf-name {
        color: var(--on-surface);
      }
      .wf-bar-track {
        position: relative;
        height: 6px;
        border-radius: 3px;
        background: var(--surface-container-highest);
        overflow: hidden;
      }
      .wf-bar {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 3px;
        background: var(--primary);
      }
      .wf-dur {
        font-size: 10.5px;
        color: var(--on-surface-variant);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .task-logs-foot {
        gap: 6px;
        margin-top: 6px;
      }
      .task-logs-modal {
        width: min(1100px, 92vw);
        height: 86vh;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
      }
      .task-logs-title {
        gap: 8px;
        margin-bottom: 6px;
      }
      .task-logs-modal .task-logs {
        flex: 1;
        max-height: none;
        font-size: 12.5px;
      }
      .task-logs-modal .waterfall-rows {
        max-height: 240px;
      }
    `,
  ];
}
