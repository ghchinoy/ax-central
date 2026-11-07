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

interface LogLine {
  id: number;
  time: string;
  text: string;
  runner: boolean;
}

const MAX_LINES = 2000;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sanitizeContainerPart = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "-");
let streams = 0;

@customElement("ax-task-logs")
export class AxTaskLogs extends LitElement {
  @property({ attribute: false }) task!: AXTask;
  @state() private lines: LogLine[] = [];
  @state() private status: "following" | "ended" | "failed" = "following";
  @state() private error = "";
  @state() private expanded =
    new URLSearchParams(location.search).get("logs") === "expanded";
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
    this.status = "following";
    this.error = "";

    const id = `task-logs-${++streams}`;
    let next = 1;
    let pending: LogLine[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;
    let other = "";
    const t = this.task;

    const pushLine = (rawText: string, time = "") => {
      const text = rawText.replace(/\r/g, "");
      pending.push({
        id: next++,
        time,
        text,
        runner: /^time=\S+ level=\w+ msg=/.test(text),
      });
      flush ??= setTimeout(() => {
        const add = pending;
        pending = [];
        flush = null;
        this.lines = [...this.lines, ...add].slice(-MAX_LINES);
      }, 50);
    };

    const offLine = window.studio.onStreamLine((l) => {
      if (l.id !== id) return;
      if (isLocal) {
        try {
          const rec = JSON.parse(l.line) as {
            message?: string;
            time?: string;
          };
          if (typeof rec?.message === "string") {
            pushLine(rec.message, rec.time ?? "");
            return;
          }
        } catch {
          // Raw container stdout/stderr line.
        }
        pushLine(l.line);
        return;
      }
      let rec: {
        labels?: Record<string, string>;
        message?: string;
        time?: string;
      };
      try {
        rec = JSON.parse(l.line) as typeof rec;
      } catch {
        if (/^error:|forbidden|not found|unable to/i.test(l.line))
          other = l.line;
        return;
      }
      const lab = rec.labels;
      if (
        !lab ||
        lab["ate.actor.name"] !== t.name ||
        lab["ate.atespace"] !== t.atespace ||
        lab["ate.actor.container.name"] !== "guest"
      )
        return;
      pushLine(rec.message ?? "", rec.time ?? "");
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
      });
    }

    this.cleanupStream = () => {
      offLine();
      offExit();
      if (flush) clearTimeout(flush);
      void window.studio.cancelStream(id);
    };
  }

  private renderLogLine = (l: LogLine): TemplateResult => {
    const cls = `task-log-line ${l.runner ? "runner" : ""}`.trim();
    const text = l.text.replace(/\r/g, "") || " ";
    return html`<div class=${cls} title=${l.time}>${text}</div>`;
  };

  private renderBody() {
    const emptyText =
      this.status === "following"
        ? "Waiting for output…"
        : this.status === "failed"
          ? this.error
          : "No output in the last 24 hours.";
    const emptyLine = html`<span class="faint">${emptyText}</span>`;
    return html`
      <div
        class="sandbox-output task-logs selectable"
        @scroll=${(e: Event) => {
          const el = e.currentTarget as HTMLElement;
          this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        ${this.lines.length === 0 ? emptyLine : this.lines.map(this.renderLogLine)}
      </div>
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
          · ${this.lines.length} ${this.lines.length === 1 ? "line" : "lines"}
        </span>
        <span class="spacer"></span>
        ${
          this.lines.length > 0
            ? html`<button
                class="btn small ghost"
                @click=${() =>
                  void navigator.clipboard.writeText(
                    this.lines.map((l) => l.text).join("\n"),
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
            <span class="faint">logs</span>
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
      .sandbox-output {
        margin: 8px 0 0;
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
        margin-bottom: 2px;
      }
      .task-logs-modal .task-logs {
        flex: 1;
        max-height: none;
        font-size: 12.5px;
      }
    `,
  ];
}
