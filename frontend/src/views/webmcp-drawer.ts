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

import { css, html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon, renderChevron } from "../icons";
import type { Caller, ToolHost } from "../registry";
import { sharedStyles } from "../shared-styles";
import { TOOL_GROUPS, TOOLS } from "../tools";

export interface ToolLogEntry {
  at: number;
  kind: "call" | "result" | "error";
  name: string;
  caller: Caller;
  text: string;
}

@customElement("ax-webmcp-drawer")
export class AxWebmcpDrawer extends LitElement {
  @property({ attribute: false }) host!: ToolHost;
  @property({ attribute: false }) log: ToolLogEntry[] = [];
  @property({ attribute: false }) disabledGroups: string[] = [];
  @state() private manualTool = "list_tasks";
  @state() private manualArgs = "{}";
  @state() private manualOut = "";

  private async runManual(): Promise<void> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(this.manualArgs || "{}") as Record<string, unknown>;
    } catch {
      this.manualOut = "Arguments are not valid JSON.";
      return;
    }
    this.manualOut = "Running…";
    const started = performance.now();
    const r = await this.host.call(
      this.manualTool,
      args,
      new AbortController().signal,
    );
    this.manualOut = `${Math.round(performance.now() - started)} ms\n${JSON.stringify(r, null, 2)}`;
  }

  private toggleGroup(group: string, on: boolean): void {
    this.dispatchEvent(
      new CustomEvent("toggle-group", {
        detail: { group, on },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private close(): void {
    this.dispatchEvent(
      new CustomEvent("close", { bubbles: true, composed: true }),
    );
  }

  override render() {
    if (!this.host) return nothing;
    const d = this.host.diagnostics;
    const mc = (document as unknown as { modelContext?: unknown }).modelContext;

    return html`
      <aside class="drawer" aria-label="WebMCP Inspector">
        <header class="drawer-head">
          <div class="col" style="gap:2px">
            <strong>WebMCP Inspector</strong>
            <span class="caption muted">
              ${
                this.host.mode === "webmcp"
                  ? "document.modelContext active"
                  : "In-app tool registry"
              }
            </span>
          </div>
          <span class="spacer"></span>
          <button
            class="btn ghost icon small"
            title="Close WebMCP Inspector"
            aria-label="Close WebMCP Inspector"
            @click=${this.close}
          >
            ${icon("x", 14)}
          </button>
        </header>

        <div class="segmented-list" role="group" aria-label="WebMCP panels">
          <details open>
            <summary><span>Tool calls</span>${renderChevron()}</summary>
            ${
              this.log.length === 0
                ? html`<p class="caption muted" style="margin:4px 0">
                    No tool calls yet. Run a tool below or invoke one via
                    <bdi dir="ltr">document.modelContext</bdi>.
                  </p>`
                : html`<ol class="log">
                    ${[...this.log]
                      .reverse()
                      .slice(0, 60)
                      .map(
                        (e) => html`
                          <li class=${e.kind}>
                            <time>${new Date(e.at).toLocaleTimeString()}</time>
                            <b><bdi dir="ltr">${e.name}</bdi></b>
                            <span
                              class="caller ${e.caller}"
                              title=${
                                e.caller === "external"
                                  ? "Called through document.modelContext by an external agent"
                                  : "Called from this app UI"
                              }
                            >
                              ${
                                e.caller === "external"
                                  ? "other agent"
                                  : "app UI"
                              }
                            </span>
                            <bdi dir="ltr">${e.text}</bdi>
                          </li>
                        `,
                      )}
                  </ol>`
            }
          </details>

          <details open>
            <summary><span>Run a tool by hand</span>${renderChevron()}</summary>
            <div class="col" style="gap:8px">
              <select
                class="select"
                .value=${this.manualTool}
                aria-label="Tool"
                @change=${(e: Event) => {
                  const name = (e.target as HTMLSelectElement).value;
                  this.manualTool = name;
                  if (name === "load_template") {
                    this.manualArgs = '{"template": "gemini"}';
                  } else if (name === "get_task" || name === "select_task") {
                    this.manualArgs = '{"name": "gemini-a1b2c3"}';
                  } else if (name === "switch_scope") {
                    this.manualArgs = '{"section": "topology"}';
                  } else {
                    this.manualArgs = "{}";
                  }
                }}
              >
                ${TOOLS.map(
                  (t) =>
                    html`<option
                      value=${t.name}
                      ?selected=${t.name === this.manualTool}
                    >
                      ${t.name}
                    </option>`,
                )}
              </select>
              <textarea
                class="textarea mono"
                rows="3"
                .value=${this.manualArgs}
                aria-label="Arguments (JSON)"
                @input=${(e: Event) =>
                  (this.manualArgs = (e.target as HTMLTextAreaElement).value)}
              ></textarea>
              <button class="btn primary" @click=${() => void this.runManual()}>
                ${icon("play", 12)} Run tool
              </button>
              ${this.manualOut ? html`<pre>${this.manualOut}</pre>` : nothing}
            </div>
          </details>

          <details>
            <summary>
              <span>Registered tool groups</span>${renderChevron()}
            </summary>
            <fieldset>
              <legend class="sr">Registered tool groups</legend>
              ${Object.keys(TOOL_GROUPS).map(
                (g) => html`
                  <label class="group-check">
                    <input
                      type="checkbox"
                      .checked=${!this.disabledGroups.includes(g)}
                      @change=${(e: Event) =>
                        this.toggleGroup(
                          g,
                          (e.target as HTMLInputElement).checked,
                        )}
                    />
                    <span>${g}</span>
                    <span class="caption faint"
                      >(${TOOL_GROUPS[g].length})</span
                    >
                  </label>
                `,
              )}
            </fieldset>
          </details>

          <details>
            <summary><span>WebMCP diagnostics</span>${renderChevron()}</summary>
            <dl class="diag">
              <dt>document.modelContext</dt>
              <dd>${mc ? "present" : "absent"} (using ${this.host.mode})</dd>
              <dt>getTools() inputSchema</dt>
              <dd>${d.schemaType || "not listed yet"}</dd>
              <dt>executeTool() args form</dt>
              <dd>${d.argsForm ?? "no call yet"}</dd>
              ${
                d.firstError
                  ? html`<dt>First form rejected</dt>
                      <dd>${d.firstError}</dd>`
                  : nothing
              }
              ${
                d.dropped.length
                  ? html`<dt>Dropped by the page</dt>
                      <dd>${d.dropped.join("; ")}</dd>`
                  : nothing
              }
              ${
                d.conflicts.length
                  ? html`<dt>Name conflicts</dt>
                      <dd class="bad">${d.conflicts.join("; ")}</dd>`
                  : nothing
              }
              <dt>Calls from other agents</dt>
              <dd>
                ${
                  this.host.mode === "webmcp"
                    ? `${this.host.externalCalls}`
                    : "n/a (in-app registry)"
                }
              </dd>
            </dl>
            <button
              class="btn small"
              @click=${() =>
                void this.host.list().then(() => this.requestUpdate())}
            >
              Re-list tools
            </button>
          </details>
        </div>
      </aside>
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        height: 100%;
      }
      .drawer {
        width: 360px;
        height: 100%;
        display: flex;
        flex-direction: column;
        background: var(--surface-bright);
        border-left: 1px solid var(--border);
        box-shadow: var(--shadow-1);
        overflow-y: auto;
      }
      .drawer-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--border);
      }

      /* Luminous 0.18 SegmentedList + vertical-flip Chevron disclosures */
      .segmented-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 12px;
      }
      .segmented-list > details {
        background: var(--surface-container);
        border-radius: var(--radius-xs);
        padding: 10px 14px;
        border: 0;
      }
      .segmented-list > details:first-of-type {
        border-top-left-radius: var(--radius-l);
        border-top-right-radius: var(--radius-l);
      }
      .segmented-list > details:last-of-type {
        border-bottom-left-radius: var(--radius-l);
        border-bottom-right-radius: var(--radius-l);
      }
      summary {
        list-style: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        cursor: pointer;
        font-weight: 600;
        user-select: none;
        border-radius: var(--radius-xs);
      }
      summary::-webkit-details-marker {
        display: none;
      }
      .chevron {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        color: var(--on-surface-variant);
        transform: scaleY(1);
        transition: transform var(--duration-medium) var(--easing-standard);
      }
      details[open] > summary .chevron {
        transform: scaleY(-1);
      }
      details[open] > summary {
        margin-bottom: 8px;
      }
      fieldset {
        border: 0;
        padding: 0;
        margin: 0;
      }
      .group-check {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 6px 0;
        cursor: pointer;
      }
      .diag {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 4px 10px;
        font-size: 12px;
        margin: 8px 0 10px;
      }
      .diag dt {
        color: var(--on-surface-variant);
      }
      .diag dd {
        margin: 0;
        word-break: break-word;
      }
      .diag .bad {
        color: var(--danger);
      }
      .log {
        list-style: none;
        margin: 4px 0 0;
        padding: 0;
        font: 12px/1.45 var(--font-mono);
        max-height: 220px;
        overflow-y: auto;
      }
      .log li {
        padding: 4px 0;
        border-bottom: 1px solid var(--surface-container-high);
        word-break: break-word;
      }
      .log li:last-child {
        border-bottom: 0;
      }
      .log time {
        color: var(--on-surface-variant);
      }
      .log .error {
        color: var(--danger);
      }
      .log .caller {
        padding: 1px 7px;
        border-radius: 999px;
        font-family: var(--font);
        font-size: 11px;
        font-weight: 500;
        background: var(--surface-container-highest);
        color: var(--on-surface);
      }
      .log .caller.external {
        background: var(--agents-violet);
        color: var(--agents-on-violet);
      }
      pre {
        white-space: pre-wrap;
        font: 12px/1.4 var(--font-mono);
        background: var(--surface-bright);
        padding: 8px;
        border-radius: var(--radius-s);
        max-height: 220px;
        overflow: auto;
        margin: 0;
      }
    `,
  ];
}
