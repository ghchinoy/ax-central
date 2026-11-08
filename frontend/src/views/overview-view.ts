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

import { css, html, LitElement, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  type IconName,
  icon,
  renderPhaseBadge,
  renderPhaseIcon,
  since,
} from "../icons";
import {
  type AXTask,
  type AXWorkspace,
  type Condition,
  PHASES,
  type Phase,
  comparePhase,
  isLocalContext,
  phaseColor,
  phaseLabel,
  repoName,
  shortImage,
  shortName,
  validateLabel,
} from "../model/resources";
import {
  type MoveStep,
  moveSteps,
  moveTask,
  taskExistsAt,
} from "../model/move";
import { type WorkspaceSnapshot, store } from "../model/store";
import { sharedStyles } from "../shared-styles";
import "./task-logs";

const STATE_ORDER: Phase[] = [
  "running",
  "pending",
  "suspended",
  "failed",
  "terminating",
  "completed",
];
const stateRank = (p: Phase) => {
  const i = STATE_ORDER.indexOf(p);
  return i < 0 ? STATE_ORDER.length : i;
};

type SortKey = "name" | "state" | "workspace" | "image" | "worker" | "age";
type Sort = { key: SortKey; dir: 1 | -1 };

const COLUMNS: { key: SortKey; title: string }[] = [
  { key: "name", title: "Name" },
  { key: "state", title: "State" },
  { key: "workspace", title: "Workspace" },
  { key: "image", title: "Image" },
  { key: "worker", title: "Worker IP" },
  { key: "age", title: "Age" },
];

interface TaskAction {
  label: string;
  iconName: IconName;
  run: () => void;
  danger?: boolean;
}

export function actionsForTask(
  t: AXTask,
  onDelete: () => void,
  onMove?: () => void,
): TaskAction[] {
  const a: TaskAction[] = [];
  if (
    t.phase === "suspended" ||
    t.phase === "failed" ||
    t.phase === "completed"
  ) {
    a.push({
      label: "Resume",
      iconName: "play",
      run: () => void store.resume(t),
    });
  }
  if (t.phase === "running" || t.phase === "pending") {
    a.push({
      label: "Suspend",
      iconName: "pause",
      run: () => void store.suspend(t),
    });
  }
  if (t.phase === "running") {
    a.push({
      label: "Terminal",
      iconName: "terminal",
      run: () => store.openTerminal(t),
    });
  }
  if (onMove) {
    a.push({
      label: "Move…",
      iconName: "arrow-right-left",
      run: onMove,
    });
  }
  a.push({
    label: "Delete…",
    iconName: "trash",
    run: onDelete,
    danger: true,
  });
  return a;
}

const INSPECTOR_WIDTH_KEY = "ax-central.inspector.width";
const INSPECTOR_DEFAULT_WIDTH = 380;
const INSPECTOR_WIDE_WIDTH = 640;
const INSPECTOR_MIN_WIDTH = 340;
const INSPECTOR_MAX_WIDTH = 780;

function formatClusterName(ctx: string): string {
  if (ctx === "local") {
    return `local (Apple container · ${store.state.settings.localServer || "localhost:8090"})`;
  }
  if (ctx === "local-podman" || ctx === "local-b") {
    return `local-podman (Podman Cluster B · ${store.state.settings.localServerB || "localhost:8091"})`;
  }
  return shortName(ctx || "local");
}

function loadInspectorWidth(): number {
  const raw = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw < INSPECTOR_MIN_WIDTH) {
    return INSPECTOR_DEFAULT_WIDTH;
  }
  return Math.min(INSPECTOR_MAX_WIDTH, Math.round(raw));
}

@customElement("ax-task-inspector")
export class AxTaskInspector extends LitElement {
  @property({ attribute: false }) task: AXTask | null = null;
  @state() private showManifest = false;
  @state() private copied = false;
  @state() private confirmDelete: AXTask | null = null;
  @state() private movingTask: AXTask | null = null;
  @state() private inspectorWidth = loadInspectorWidth();
  @state() private dragging = false;
  private offStore: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.inspectorWidth = loadInspectorWidth();
    this.offStore = store.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offStore?.();
  }

  private setInspectorWidth(w: number): void {
    const clamped = Math.max(
      INSPECTOR_MIN_WIDTH,
      Math.min(INSPECTOR_MAX_WIDTH, Math.round(w)),
    );
    this.inspectorWidth = clamped;
    localStorage.setItem(INSPECTOR_WIDTH_KEY, String(clamped));
  }

  private toggleInspectorWidth(): void {
    const next =
      this.inspectorWidth > INSPECTOR_DEFAULT_WIDTH
        ? INSPECTOR_DEFAULT_WIDTH
        : INSPECTOR_WIDE_WIDTH;
    this.setInspectorWidth(next);
  }

  private resetInspectorWidth = (): void => {
    this.setInspectorWidth(INSPECTOR_DEFAULT_WIDTH);
  };

  private startResize = (e: MouseEvent): void => {
    e.preventDefault();
    const rightEdge = this.getBoundingClientRect().right;
    this.dragging = true;
    const move = (ev: MouseEvent) => {
      this.setInspectorWidth(rightEdge - ev.clientX);
    };
    const up = () => {
      this.dragging = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  private async copyManifest(manifest?: string): Promise<void> {
    if (!manifest) return;
    await navigator.clipboard.writeText(manifest);
    this.copied = true;
    setTimeout(() => (this.copied = false), 1400);
  }

  private renderLifecycle(phase: Phase, conditions: Condition[]) {
    const find = (type: string) => conditions.find((c) => c.type === type);
    const isTrue = (c?: Condition) => c?.status.toLowerCase() === "true";
    const ready = find("Ready");
    const ws = find("WorkspaceReady");
    const green = "var(--green)";
    const stages: {
      id: string;
      iconName: IconName | null;
      done: boolean;
      tint: string;
      hint?: string;
    }[] = [
      { id: "Created", iconName: "plus", done: true, tint: green },
      {
        id: "Workspace",
        iconName: "folder-git",
        done: isTrue(ws) || isTrue(ready),
        tint: green,
        hint: ws?.reason || ws?.message,
      },
      {
        id: "Ready",
        iconName: "bolt",
        done: isTrue(ready),
        tint: green,
        hint: ready?.reason || ready?.message,
      },
    ];
    if (phase !== "running" && phase !== "pending") {
      stages.push({
        id: phaseLabel(phase),
        iconName: null,
        done: true,
        tint: phaseColor(phase),
      });
    }

    return html`
      <div class="lifecycle">
        ${stages.map(
          (st, i) => html`
            <div
              class="stage ${st.done ? "done" : ""}"
              style="--c:${st.tint}"
              title=${st.hint ?? ""}
            >
              ${
                i > 0
                  ? html`<span
                      class="stage-line ${st.done ? "done" : ""}"
                    ></span>`
                  : nothing
              }
              <span class="stage-dot">
                ${
                  st.iconName
                    ? icon(st.iconName, 13)
                    : renderPhaseIcon(phase, 14)
                }
              </span>
              <span class="stage-label">${st.id}</span>
            </div>
          `,
        )}
      </div>
    `;
  }

  override render() {
    const s = store.state;
    const t =
      this.task ?? s.tasks.find((x) => x.id === s.selectedTaskID) ?? null;
    const detail = t ? s.details[t.id] : undefined;

    const fields: [string, string | undefined][] = t
      ? [
          ["Cluster", formatClusterName(s.context || "local")],
          ["Image", detail?.image],
          [
            "Command",
            detail?.command.length ? detail.command.join(" ") : undefined,
          ],
          [
            "Workspace",
            detail?.workspace
              ? `${detail.workspace} → /workspace`
              : "empty /workspace",
          ],
          [
            "Resources",
            detail?.cpu || detail?.memory
              ? `${detail?.cpu ?? "–"} CPU · ${detail?.memory ?? "–"}`
              : undefined,
          ],
          ["Worker IP", t.workerIP],
          ["Actor", t.actor],
          [
            "Debug",
            detail
              ? detail.debug
                ? "on (guest services for ax ssh)"
                : "off"
              : undefined,
          ],
        ]
      : [];

    const isWide = this.inspectorWidth > INSPECTOR_DEFAULT_WIDTH;

    return html`
      <aside
        class="inspector ${t ? "open" : ""} ${this.dragging ? "dragging" : ""}"
        style=${t ? `--inspector-w:${this.inspectorWidth}px` : ""}
        aria-label="Task inspector"
      >
        ${
          t
            ? html`
                <div
                  class="inspector-resizer"
                  title="Drag to resize · Double-click to reset width"
                  @mousedown=${this.startResize}
                  @dblclick=${this.resetInspectorWidth}
                ></div>
                <div class="inspector-inner fade-in">
                  <header class="inspector-head">
                    <div class="col" style="gap:6px;min-width:0">
                      <strong
                        class="inspector-title ellipsis selectable"
                        title=${t.name}
                        ><bdi dir="ltr">${t.name}</bdi></strong
                      >
                      <div class="row">
                        ${renderPhaseBadge(t.phase)}
                        <span class="caption faint"
                          ><bdi dir="ltr"
                            >${shortName(s.context || "local")} /
                            ${t.atespace}</bdi
                          >
                          · ${t.age}</span
                        >
                      </div>
                    </div>
                    <span class="spacer"></span>
                    <button
                      class="btn ghost icon small"
                      title=${
                        isWide
                          ? "Restore default inspector width (380px)"
                          : "Expand inspector width (640px)"
                      }
                      aria-label=${
                        isWide
                          ? "Restore inspector width"
                          : "Expand inspector width"
                      }
                      @click=${() => this.toggleInspectorWidth()}
                    >
                      ${icon(isWide ? "minimize" : "maximize", 14)}
                    </button>
                    <button
                      class="btn ghost icon small"
                      title="Close"
                      aria-label="Close inspector"
                      @click=${() => store.set({ selectedTaskID: null })}
                    >
                      ${icon("x", 15)}
                    </button>
                  </header>

                  <div class="inspector-body">
                    ${this.renderLifecycle(t.phase, detail?.conditions ?? [])}

                    <div class="row" style="flex-wrap:wrap">
                      ${actionsForTask(
                        t,
                        () => (this.confirmDelete = t),
                        () => (this.movingTask = t),
                      ).map(
                        (a) => html`
                          <button
                            class="btn small ${a.danger ? "danger" : ""}"
                            @click=${a.run}
                          >
                            ${icon(a.iconName, 12)} ${a.label.replace("…", "")}
                          </button>
                        `,
                      )}
                    </div>

                    <section class="inspector-section">
                      <h4>Sandbox</h4>
                      <dl class="fields">
                        ${fields
                          .filter(([, v]) => v)
                          .map(
                            ([k, v]) => html`
                              <div class="field">
                                <dt>${k}</dt>
                                <dd
                                  class=${
                                    k === "Image" ||
                                    k === "Command" ||
                                    k === "Worker IP"
                                      ? "mono selectable"
                                      : "selectable"
                                  }
                                >
                                  <bdi dir="ltr">${v}</bdi>
                                </dd>
                              </div>
                            `,
                          )}
                      </dl>
                    </section>

                    ${
                      detail?.conditions.length
                        ? html`
                            <section class="inspector-section">
                              <h4>Conditions</h4>
                              <div class="conditions">
                                ${detail.conditions.map((c) => {
                                  const ok = c.status.toLowerCase() === "true";
                                  return html`
                                    <div class="condition">
                                      ${icon(
                                        ok ? "circle-check" : "circle-x",
                                        15,
                                        {
                                          color: ok
                                            ? "var(--green)"
                                            : "var(--orange)",
                                        },
                                      )}
                                      <div
                                        class="col"
                                        style="gap:2px;min-width:0;flex:1"
                                      >
                                        <div class="row">
                                          <strong>${c.type}</strong>
                                          <span class="caption faint"
                                            >${ok ? "True" : c.status}</span
                                          >
                                          <span class="spacer"></span>
                                          ${
                                            c.updateTime
                                              ? html`<span
                                                  class="caption faint"
                                                  title=${c.updateTime}
                                                  >${since(c.updateTime)}
                                                  ago</span
                                                >`
                                              : nothing
                                          }
                                        </div>
                                        ${
                                          c.reason
                                            ? html`<span class="caption"
                                                >${c.reason}</span
                                              >`
                                            : nothing
                                        }
                                        ${
                                          c.message
                                            ? html`<span
                                                class="caption muted selectable"
                                                >${c.message}</span
                                              >`
                                            : nothing
                                        }
                                      </div>
                                    </div>
                                  `;
                                })}
                              </div>
                            </section>
                          `
                        : nothing
                    }

                    <section class="inspector-section">
                      <h4>Logs &amp; Telemetry</h4>
                      <ax-task-logs .task=${t}></ax-task-logs>
                    </section>

                    <section class="inspector-section">
                      <div class="row">
                        <button
                          class="section-toggle"
                          @click=${() =>
                            (this.showManifest = !this.showManifest)}
                        >
                          ${icon("chevron-right", 13, {
                            className: this.showManifest ? "rot" : "",
                          })}
                          Manifest
                        </button>
                        <span class="spacer"></span>
                        <button
                          class="btn small ghost"
                          ?disabled=${!detail?.manifest}
                          title="Copy the manifest as YAML"
                          @click=${() => void this.copyManifest(detail?.manifest)}
                        >
                          ${icon(this.copied ? "check" : "copy", 12)}
                          ${this.copied ? "Copied" : "Copy"}
                        </button>
                      </div>
                      ${
                        this.showManifest
                          ? html`<div class="manifest selectable">
                              <span class="manifest-text"
                                >${(detail?.manifest || "loading…").replace(
                                  /\r/g,
                                  "",
                                )}</span
                              >
                            </div>`
                          : nothing
                      }
                    </section>
                  </div>
                </div>
              `
            : nothing
        }
      </aside>

      ${
        this.confirmDelete
          ? renderDeleteTaskModal(this.confirmDelete, () => {
              this.confirmDelete = null;
            })
          : nothing
      }
      ${
        this.movingTask
          ? html`<ax-move-task-modal
              .task=${this.movingTask}
              .onClose=${() => {
                this.movingTask = null;
              }}
            ></ax-move-task-modal>`
          : nothing
      }
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
        height: 100%;
      }
      .inspector {
        position: relative;
        width: 0;
        flex: none;
        overflow: hidden;
        transition: width var(--duration-medium) var(--easing-standard);
        border-left: 1px solid transparent;
        background: var(--surface-bright);
      }
      .inspector.open {
        width: min(var(--inspector-w, 380px), 65vw);
        border-left-color: var(--border);
        box-shadow: var(--shadow-1);
      }
      .inspector.dragging {
        transition: none;
        user-select: none;
      }
      .inspector-resizer {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 5px;
        cursor: col-resize;
        z-index: 3;
      }
      .inspector-resizer:hover,
      .inspector.dragging .inspector-resizer {
        background: color-mix(in srgb, var(--primary) 45%, transparent);
      }
      .inspector-inner {
        width: 100%;
        min-width: 340px;
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      .inspector-head {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 18px 16px 14px 20px;
        border-bottom: 1px solid var(--border);
      }
      .inspector-title {
        font-size: 16px;
      }
      .inspector-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px 24px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      .inspector-section h4 {
        margin: 0 0 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-3);
      }
      .fields {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 7px;
      }
      .field {
        display: grid;
        grid-template-columns: 82px 1fr;
        gap: 10px;
        align-items: baseline;
      }
      .field dt {
        color: var(--text-3);
        font-size: 12px;
      }
      .field dd {
        margin: 0;
        word-break: break-all;
        font-size: 12px;
      }
      .conditions {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .condition {
        display: flex;
        gap: 9px;
        align-items: flex-start;
      }
      .section-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 0;
        background: transparent;
        padding: 0;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-3);
      }
      .section-toggle svg {
        transition: transform var(--duration-fast) var(--easing-standard);
      }
      .section-toggle svg.rot {
        transform: rotate(90deg);
      }
      .manifest {
        display: flex;
        margin: 8px 0 0;
        padding: 10px 12px;
        border-radius: var(--radius-s);
        background: var(--surface-container);
        border: 1px solid var(--border);
        font-family: var(--font-mono);
        font-size: 11px;
        line-height: 1.5;
        overflow: auto;
        max-height: 360px;
      }
      .manifest-text {
        white-space: pre;
      }
      .lifecycle {
        display: flex;
        align-items: flex-start;
        padding: 4px 0 2px;
      }
      .stage {
        flex: 1;
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .stage-line {
        position: absolute;
        top: 13px;
        right: 50%;
        width: 100%;
        height: 2px;
        background: var(--outline-variant);
        z-index: 0;
      }
      .stage-line.done {
        background: var(--c);
      }
      .stage-dot {
        position: relative;
        z-index: 1;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--surface-bright);
        border: 2px solid var(--outline-variant);
        color: var(--text-3);
      }
      .stage.done .stage-dot {
        border-color: var(--c);
        color: var(--c);
        background: color-mix(in srgb, var(--c) 12%, var(--surface-bright));
      }
      .stage-label {
        font-size: 11px;
        color: var(--text-3);
      }
      .stage.done .stage-label {
        color: var(--on-surface-variant);
        font-weight: 500;
      }
    `,
  ];
}

function renderDeleteTaskModal(task: AXTask, onClose: () => void) {
  return html`
    <div class="modal-backdrop" @mousedown=${onClose}>
      <div
        class="modal card fade-in"
        role="dialog"
        aria-label="Delete task"
        @mousedown=${(e: Event) => e.stopPropagation()}
      >
        <h3>Delete task “${task.name}”?</h3>
        <p class="muted" style="margin:0 0 18px;line-height:1.5">
          Its sandbox is torn down and the task is removed from
          <strong>${task.atespace}</strong>. This can't be undone.
        </p>
        <div class="row" style="justify-content:flex-end">
          <button class="btn" @click=${onClose}>Cancel</button>
          <button
            class="btn primary danger"
            @click=${() => {
              onClose();
              if (store.state.selectedTaskID === task.id)
                store.set({ selectedTaskID: null });
              void store.remove("task", task.name);
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  `;
}

@customElement("ax-move-task-modal")
export class AxMoveTaskModal extends LitElement {
  @property({ attribute: false }) task!: AXTask;
  @property({ attribute: false }) onClose: () => void = () => {};

  @state() private context = "";
  @state() private atespace = "";
  @state() private deleteOriginal = false;
  @state() private overwriteExisting = false;
  @state() private destExists = false;
  @state() private clearUnpinnedImage = true;
  @state() private steps: MoveStep[] | null = null;
  @state() private done = false;
  @state() private initializedFor = "";
  private checkToken = 0;

  override willUpdate(): void {
    if (this.task && this.initializedFor !== this.task.id) {
      this.initializedFor = this.task.id;
      const s = store.state;
      const otherCtx = s.contexts.find((c) => c.name !== s.context)?.name;
      this.context = otherCtx || s.context || "local";
      this.atespace = otherCtx
        ? s.atespace
        : s.atespace === "default"
          ? "staging"
          : "default";
      this.deleteOriginal = false;
      this.overwriteExisting = false;
      this.destExists = false;
      this.clearUnpinnedImage = true;
      this.steps = null;
      this.done = false;
      void this.probeDestinationCollision();
    }
  }

  private async probeDestinationCollision(): Promise<void> {
    if (!this.task) return;
    const trimmedAtes = this.atespace.trim() || "default";
    const s = store.state;
    const samePlace =
      this.context === s.context && trimmedAtes === this.task.atespace;
    if (samePlace || validateLabel(trimmedAtes) !== null) {
      this.destExists = false;
      return;
    }
    const token = ++this.checkToken;
    const exists = await taskExistsAt(
      this.context,
      trimmedAtes,
      this.task.name,
    );
    if (token === this.checkToken) {
      this.destExists = exists;
    }
  }

  private async runMove(): Promise<void> {
    const target = {
      context: this.context,
      atespace: this.atespace.trim() || "default",
      clearUnpinnedImage: this.clearUnpinnedImage,
      overwriteExisting: this.overwriteExisting,
    };
    this.steps = moveSteps(target, this.deleteOriginal);
    this.done = await moveTask(
      this.task,
      target,
      this.deleteOriginal,
      (next) => {
        this.steps = [...next];
      },
    );
  }

  private showMoved(): void {
    const targetCtx = this.context;
    const targetAtes = this.atespace.trim() || "default";
    const taskName = this.task.name;
    this.onClose();
    store.setScope({ context: targetCtx, atespace: targetAtes });
    store.showTask(taskName);
  }

  override render() {
    const s = store.state;
    const detail = s.details[this.task.id];
    const busy =
      this.steps !== null &&
      !this.done &&
      !this.steps.some((st) => st.state === "failed");
    const trimmedAtes = this.atespace.trim() || "default";
    const atesErr = validateLabel(trimmedAtes);
    const samePlace =
      this.context === s.context && trimmedAtes === this.task.atespace;
    const noDebug = detail !== undefined && !detail.debug;
    const unpinnedToCluster =
      !isLocalContext(this.context) &&
      Boolean(detail?.image && !detail.image.includes("@sha256:"));
    const collisionBlocked = this.destExists && !this.overwriteExisting;
    const canStart =
      !busy &&
      !this.done &&
      !atesErr &&
      !samePlace &&
      !noDebug &&
      !collisionBlocked;

    return html`
      <div
        class="modal-backdrop"
        @mousedown=${() => {
          if (!busy) this.onClose();
        }}
      >
        <div
          class="modal card fade-in move-modal"
          role="dialog"
          aria-label="Move task"
          @mousedown=${(e: Event) => e.stopPropagation()}
        >
          <h3>Move task “${this.task.name}”</h3>
          <p class="muted" style="margin:0 0 12px;line-height:1.5">
            Recreates the task at the destination and copies
            <code>/workspace</code> over <code>ax ssh</code>. Processes restart
            against the copied files.
          </p>

          <div class="move-route" aria-label="Task migration route">
            <div class="move-endpoint">
              <span class="move-ep-tag">Current cluster</span>
              <strong
                class="ellipsis"
                title=${formatClusterName(s.context || "local")}
                ><bdi dir="ltr"
                  >${formatClusterName(s.context || "local")}</bdi
                ></strong
              >
              <span class="caption faint"
                >atespace <bdi dir="ltr">${this.task.atespace}</bdi></span
              >
            </div>
            <div class="move-route-arrow" aria-hidden="true">
              ${icon("arrow-right-left", 15, { color: "var(--primary)" })}
            </div>
            <div class="move-endpoint dest">
              <span class="move-ep-tag">Destination cluster</span>
              <strong
                class="ellipsis"
                title=${formatClusterName(this.context || "local")}
                ><bdi dir="ltr"
                  >${formatClusterName(this.context || "local")}</bdi
                ></strong
              >
              <span class="caption faint"
                >atespace <bdi dir="ltr">${trimmedAtes}</bdi></span
              >
            </div>
          </div>

          ${
            noDebug
              ? html`
                  <div class="move-warn">
                    ${icon("alert", 15, { color: "var(--orange)" })}
                    <span
                      >Moving copies files over <code>ax ssh</code>, which
                      requires <code>spec.debug: true</code> on this task.</span
                    >
                  </div>
                `
              : nothing
          }

          <div class="move-form">
            <div class="move-field">
              <label class="move-label" for="move-context"
                >Destination cluster</label
              >
              <select
                id="move-context"
                class="input"
                ?disabled=${busy || this.done}
                .value=${this.context}
                @change=${(e: Event) => {
                  this.context = (e.target as HTMLSelectElement).value;
                  void this.probeDestinationCollision();
                }}
              >
                ${s.contexts.map(
                  (c) => html`
                    <option
                      value=${c.name}
                      ?selected=${c.name === this.context}
                    >
                      ${
                        c.name === "local"
                          ? "local (Apple container · :8090)"
                          : c.name === "local-podman"
                            ? "local-podman (Podman Cluster B · :8091)"
                            : shortName(c.name)
                      }
                    </option>
                  `,
                )}
              </select>
            </div>

            <div class="move-field">
              <label class="move-label" for="move-atespace"
                >Destination atespace</label
              >
              <input
                id="move-atespace"
                list="move-atespace-list"
                class="input mono ${atesErr ? "invalid" : ""}"
                ?disabled=${busy || this.done}
                .value=${this.atespace}
                placeholder="default"
                @input=${(e: Event) => {
                  this.atespace = (e.target as HTMLInputElement).value;
                  void this.probeDestinationCollision();
                }}
              />
              <datalist id="move-atespace-list">
                <option value="default"></option>
                <option value="staging"></option>
                <option value="prod"></option>
              </datalist>
            </div>
          </div>

          ${
            atesErr
              ? html`<div
                  class="caption"
                  style="color:var(--danger);margin-bottom:8px"
                >
                  Atespace ${atesErr}
                </div>`
              : samePlace && !this.steps
                ? html`<div class="caption faint" style="margin-bottom:8px">
                    Choose a different context or atespace.
                  </div>`
                : nothing
          }
          ${
            unpinnedToCluster
              ? html`
                  <label class="move-check">
                    <input
                      type="checkbox"
                      ?disabled=${busy || this.done}
                      .checked=${this.clearUnpinnedImage}
                      @change=${(e: Event) => {
                        this.clearUnpinnedImage = (
                          e.target as HTMLInputElement
                        ).checked;
                      }}
                    />
                    <span>
                      Use destination default runner image (recommended:
                      <code>${detail?.image}</code> has no
                      <code>@sha256:</code> digest)
                    </span>
                  </label>
                `
              : nothing
          }

          <label class="move-check">
            <input
              type="checkbox"
              ?disabled=${busy || this.done}
              .checked=${this.deleteOriginal}
              @change=${(e: Event) => {
                this.deleteOriginal = (e.target as HTMLInputElement).checked;
              }}
            />
            <span>
              Delete original in
              <strong>${s.context} / ${this.task.atespace}</strong> after copy
              (otherwise suspend it)
            </span>
          </label>

          <label
            class="move-check ${
              this.destExists && !this.overwriteExisting ? "warn" : ""
            }"
          >
            <input
              type="checkbox"
              ?disabled=${busy || this.done}
              .checked=${this.overwriteExisting}
              @change=${(e: Event) => {
                this.overwriteExisting = (e.target as HTMLInputElement).checked;
              }}
            />
            <span>
              Replace existing
              <strong><bdi dir="ltr">${this.task.name}</bdi></strong> in
              <strong>${shortName(this.context)} / ${trimmedAtes}</strong>${
                this.destExists
                  ? html` <span class="move-exists-badge"
                      >already exists there</span
                    >`
                  : " if present"
              }
            </span>
          </label>

          ${
            this.steps
              ? html`
                  <div class="move-steps" aria-live="polite">
                    ${this.steps.map((st) => {
                      const ic: IconName =
                        st.state === "done"
                          ? "circle-check"
                          : st.state === "failed"
                            ? "circle-x"
                            : st.state === "running"
                              ? "loader"
                              : "circle-dashed";
                      const col =
                        st.state === "done"
                          ? "var(--green)"
                          : st.state === "failed"
                            ? "var(--danger)"
                            : st.state === "running"
                              ? "var(--primary)"
                              : "var(--text-3)";
                      return html`
                        <div class="move-step ${st.state}">
                          ${icon(ic, 14, {
                            color: col,
                            className: st.state === "running" ? "spin" : "",
                          })}
                          <div class="col" style="gap:2px;min-width:0;flex:1">
                            <span>${st.title}</span>
                            ${
                              st.detail
                                ? html`<span class="caption selectable"
                                    >${st.detail}</span
                                  >`
                                : nothing
                            }
                          </div>
                        </div>
                      `;
                    })}
                  </div>
                `
              : nothing
          }

          <div class="row" style="justify-content:flex-end;margin-top:16px">
            <button
              class="btn"
              ?disabled=${busy}
              @click=${() => this.onClose()}
            >
              ${this.done ? "Close" : "Cancel"}
            </button>
            ${
              this.done
                ? html`
                    <button
                      class="btn primary"
                      @click=${() => this.showMoved()}
                    >
                      Show in ${shortName(this.context)} / ${trimmedAtes}
                    </button>
                  `
                : html`
                    <button
                      class="btn primary"
                      ?disabled=${!canStart}
                      @click=${() => void this.runMove()}
                    >
                      ${icon("arrow-right-left", 13)}
                      ${this.steps ? "Retry" : "Move"}
                    </button>
                  `
            }
          </div>
        </div>
      </div>
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      .move-modal {
        width: 520px;
        max-width: calc(100vw - 32px);
        box-sizing: border-box;
      }
      .move-route {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        margin-bottom: 12px;
        border-radius: var(--radius-s);
        background: var(--surface-container);
        border: 1px solid var(--border);
        font-size: 12px;
      }
      .move-endpoint {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .move-endpoint.dest {
        border-left: 2px solid var(--primary);
        padding-left: 10px;
      }
      .move-ep-tag {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-3);
      }
      .move-route-arrow {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .move-warn {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 10px 12px;
        margin-bottom: 12px;
        border-radius: var(--radius-s);
        background: color-mix(
          in srgb,
          var(--orange) 12%,
          var(--surface-bright)
        );
        border: 1px solid color-mix(in srgb, var(--orange) 35%, var(--border));
        font-size: 12.5px;
      }
      .move-form {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
        gap: 10px;
        margin-bottom: 10px;
      }
      .move-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .move-field .input {
        width: 100%;
        box-sizing: border-box;
      }
      .move-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-3);
      }
      .move-check {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 12.5px;
        color: var(--on-surface-variant);
        margin: 6px 0;
        cursor: pointer;
      }
      .move-check input {
        margin-top: 2px;
      }
      .move-check.warn {
        padding: 7px 10px;
        border-radius: var(--radius-s);
        background: color-mix(
          in srgb,
          var(--orange) 12%,
          var(--surface-bright)
        );
        border: 1px solid color-mix(in srgb, var(--orange) 35%, var(--border));
        color: var(--on-surface);
      }
      .move-exists-badge {
        display: inline-block;
        margin-left: 4px;
        padding: 1px 6px;
        border-radius: 999px;
        font-size: 10.5px;
        font-weight: 600;
        background: color-mix(
          in srgb,
          var(--orange) 18%,
          var(--surface-bright)
        );
        color: var(--on-surface);
      }
      .move-steps {
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: var(--radius-s);
        background: var(--surface-container);
        border: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 12.5px;
      }
      .move-step {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .move-step.pending {
        color: var(--text-3);
      }
      .move-step.failed .caption {
        color: var(--danger);
      }
    `,
  ];
}

@customElement("ax-overview")
export class AxOverview extends LitElement {
  @state() private sort: Sort = { key: "state", dir: 1 };
  @state() private menu: { task: AXTask; x: number; y: number } | null = null;
  @state() private confirmTask: AXTask | null = null;
  @state() private movingTask: AXTask | null = null;
  @state() private confirmWorkspace: AXWorkspace | null = null;
  @state() private activeSnapshot: WorkspaceSnapshot | null = null;
  @state() private snapshotFiles: string[] = [];
  @state() private snapshotPreviews: Record<string, string> = {};
  @state() private selectedSnapshotFile: string | null = null;
  @state() private loadingSnapshot = false;

  private offStore: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.offStore = store.subscribe(() => this.requestUpdate());
    window.addEventListener("mousedown", this.closeMenu);
    window.addEventListener("keydown", this.onKey);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offStore?.();
    window.removeEventListener("mousedown", this.closeMenu);
    window.removeEventListener("keydown", this.onKey);
  }

  private closeMenu = (): void => {
    if (this.menu) this.menu = null;
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.menu) this.menu = null;
  };

  private onSort(key: SortKey): void {
    this.sort = {
      key,
      dir: this.sort.key === key ? (-this.sort.dir as 1 | -1) : 1,
    };
  }

  private sortedTasks(): AXTask[] {
    const s = store.state;
    const created = (t: AXTask) =>
      Date.parse(s.details[t.id]?.createTime ?? "") || 0;
    const value = (t: AXTask): string | number => {
      const d = s.details[t.id];
      switch (this.sort.key) {
        case "name":
          return t.name;
        case "state":
          return stateRank(t.phase);
        case "workspace":
          return d?.workspace ?? "";
        case "image":
          return d?.image ? shortImage(d.image) : "";
        case "worker":
          return t.workerIP ?? "";
        case "age":
          return -created(t);
      }
    };
    const cmp = (a: string | number, b: string | number) =>
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true });
    return [...s.tasks].sort(
      (a, b) =>
        cmp(value(a), value(b)) * this.sort.dir ||
        stateRank(a.phase) - stateRank(b.phase) ||
        a.name.localeCompare(b.name),
    );
  }

  private renderSparkline() {
    const history = store.state.history;
    const W = 180;
    const H = 40;
    let chart: { phase: Phase; d: string; line: string }[] | null = null;
    if (history.length >= 2) {
      const seen = PHASES.filter((p) =>
        history.some((h) => (h.counts[p] ?? 0) > 0),
      );
      const t0 = history[0].date;
      const t1 = history[history.length - 1].date;
      const max = Math.max(
        1,
        ...history.map((h) => seen.reduce((a, p) => a + (h.counts[p] ?? 0), 0)),
      );
      const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
      const y = (v: number) => H - 1 - (v / max) * (H - 2);
      chart = seen.map((p, i) => {
        const lower = history.map((h) =>
          seen.slice(0, i).reduce((a, q) => a + (h.counts[q] ?? 0), 0),
        );
        const upper = history.map((h, j) => lower[j] + (h.counts[p] ?? 0));
        const top = history.map((h, j) => `${x(h.date)},${y(upper[j])}`);
        const bottom = history
          .map((h, j) => `${x(h.date)},${y(lower[j])}`)
          .reverse();
        return {
          phase: p,
          d: `M${top.join("L")}L${bottom.join("L")}Z`,
          line: `M${top.join("L")}`,
        };
      });
    }
    const last = history[history.length - 1];
    const summary = last
      ? PHASES.filter((p) => last.counts[p])
          .map((p) => `${phaseLabel(p)} ${last.counts[p]}`)
          .join(" · ")
      : "";

    return html`
      <div class="digest-spark" title=${summary}>
        <span class="caption faint">This session</span>
        ${
          chart
            ? html`<svg
                viewBox="0 0 ${W} ${H}"
                preserveAspectRatio="none"
                width=${W}
                height=${H}
                aria-hidden="true"
              >
                ${chart.map(
                  (b) => svg`
                    <g>
                      <path
                        d=${b.d}
                        fill=${phaseColor(b.phase)}
                        opacity="0.75"
                      />
                      <path
                        d=${b.line}
                        fill="none"
                        stroke=${phaseColor(b.phase)}
                        stroke-width="1.5"
                        vector-effect="non-scaling-stroke"
                      />
                    </g>
                  `,
                )}
              </svg>`
            : html`<div class="digest-spark-empty faint">collecting…</div>`
        }
      </div>
    `;
  }

  private renderDigest() {
    const s = store.state;
    const counts = new Map<Phase, number>();
    for (const t of s.tasks)
      counts.set(t.phase, (counts.get(t.phase) ?? 0) + 1);
    const phases = [...counts.keys()].sort(comparePhase);
    const latest = s.activity[0];

    return html`
      <section class="card digest" aria-label="Atespace digest">
        <div class="digest-tasks">
          <button
            class="digest-total"
            title="Jump to tasks"
            @click=${() =>
              this.renderRoot
                .querySelector("#task-board")
                ?.scrollIntoView({ behavior: "smooth" })}
          >
            <span class="digest-value num">${s.tasks.length}</span>
            <span class="muted"
              >${s.tasks.length === 1 ? "task" : "tasks"}</span
            >
          </button>
          <div class="digest-phases">
            <div class="row digest-chips">
              ${
                phases.length === 0
                  ? html`<span class="muted"
                      >No tasks in this atespace yet.</span
                    >`
                  : phases.map(
                      (p) => html`
                        <span
                          class="row digest-chip"
                          title="${phaseLabel(p)}: ${counts.get(p)}"
                        >
                          ${renderPhaseIcon(p, 13)}
                          <span class="muted">${phaseLabel(p)}</span>
                          <span class="num">${counts.get(p)}</span>
                        </span>
                      `,
                    )
              }
            </div>
            ${
              phases.length > 0
                ? html`
                    <div class="digest-bar">
                      ${phases.map(
                        (p) => html`
                          <div
                            title="${phaseLabel(p)}: ${counts.get(p)}"
                            style="flex-grow:${counts.get(
                              p,
                            )};background:${phaseColor(p)}"
                          ></div>
                        `,
                      )}
                    </div>
                  `
                : nothing
            }
          </div>
        </div>

        <div class="digest-divider"></div>
        ${this.renderSparkline()}
        <div class="digest-divider"></div>

        <div class="digest-side">
          <button
            class="row digest-link"
            title="Open Map"
            @click=${() => store.setSection("topology")}
          >
            ${icon("folder-git", 14, { color: "var(--purple)" })}
            <span class="num">${s.workspaces.length}</span>
            <span class="muted">workspaces</span>
            <span style="margin-left:8px"
              >${icon("cpu", 14, { color: "var(--teal)" })}</span
            >
            <span class="num">${s.models.length}</span>
            <span class="muted">models</span>
          </button>
          <div class="row digest-activity" title=${latest?.detail ?? ""}>
            ${
              latest
                ? html`
                    ${icon(latest.ok ? "circle-check" : "alert", 13, {
                      color: latest.ok ? "var(--green)" : "var(--danger)",
                    })}
                    <span class="ellipsis">${latest.title}</span>
                    <span class="faint">${since(latest.date)}</span>
                  `
                : html`<span class="faint">No activity yet this session</span>`
            }
          </div>
        </div>
      </section>
    `;
  }

  private renderWorkspaces() {
    const s = store.state;
    const users = (w: AXWorkspace) =>
      s.tasks.filter((t) => s.details[t.id]?.workspace === w.name);
    const workspaces = [...s.workspaces].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return html`
      <div class="row board-head" style="margin-top:18px">
        <h2>Workspaces</h2>
        <span class="caption faint">What tasks mount at /workspace.</span>
      </div>
      ${
        workspaces.length === 0
          ? html`
              <div class="card board-empty">
                <div class="empty">
                  ${icon("folder-git", 28)}
                  <div style="font-weight:600;color:var(--on-surface-variant)">
                    No workspaces in this atespace
                  </div>
                </div>
              </div>
            `
          : html`
              <div class="card task-table-wrap">
                <table class="task-table" aria-label="Workspaces">
                  <thead>
                    <tr>
                      <th class="col-name">
                        <span class="th-label">Name</span>
                      </th>
                      <th class="col-repos">
                        <span class="th-label">Repos</span>
                      </th>
                      <th class="col-mcp">
                        <span class="th-label">MCP servers</span>
                      </th>
                      <th class="col-files">
                        <span class="th-label">Files</span>
                      </th>
                      <th class="col-used">
                        <span class="th-label">Tasks</span>
                      </th>
                      <th class="col-actions">
                        <span class="sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    ${workspaces.map((w) => {
                      const n = users(w).length;
                      return html`
                        <tr class="task-row" style="--c:var(--purple)">
                          <td class="col-name">
                            <span class="row task-row-ws">
                              ${icon("folder-git", 13, { color: "var(--purple)" })}
                              <span
                                class="task-row-name ellipsis"
                                title=${w.name}
                                ><bdi dir="ltr">${w.name}</bdi></span
                              >
                            </span>
                          </td>
                          <td
                            class="col-repos ellipsis"
                            title=${w.repos
                              .map((r) => `${r.repo} (${r.branch})`)
                              .join("\n")}
                          >
                            ${
                              w.repos.length
                                ? w.repos
                                    .map((r) => repoName(r.repo))
                                    .join(", ")
                                : html`<span class="faint">–</span>`
                            }
                          </td>
                          <td
                            class="col-mcp ellipsis"
                            title=${w.mcpServers
                              .map((m) => `${m.name} · ${m.endpoint}`)
                              .join("\n")}
                          >
                            ${
                              w.mcpServers.length
                                ? w.mcpServers.map((m) => m.name).join(", ")
                                : html`<span class="faint">–</span>`
                            }
                          </td>
                          <td
                            class="col-files ellipsis"
                            title=${w.files.join("\n")}
                          >
                            ${
                              w.files.length
                                ? w.files.join(", ")
                                : html`<span class="faint">–</span>`
                            }
                          </td>
                          <td class="col-used num">
                            ${n || html`<span class="faint">0</span>`}
                          </td>
                          <td class="col-actions">
                            <div class="task-row-actions">
                              <button
                                class="btn ghost small icon danger"
                                title="Delete workspace"
                                aria-label="Delete workspace ${w.name}"
                                @click=${() => (this.confirmWorkspace = w)}
                              >
                                ${icon("trash", 12)}
                              </button>
                            </div>
                          </td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              </div>
            `
      }
    `;
  }

  override render() {
    const s = store.state;
    const ctx = store.currentContext;
    const subtitle = `${ctx ? (ctx.name === "local" ? "local control plane (:8090)" : ctx.name === "local-podman" ? "local Podman Cluster B (:8091)" : shortName(ctx.name)) : "…"} · atespace ${s.atespace}`;
    const tasks = this.sortedTasks();
    const resumable = s.tasks.filter(
      (t) =>
        t.phase === "suspended" ||
        t.phase === "failed" ||
        t.phase === "completed",
    );
    const suspendable = s.tasks.filter(
      (t) => t.phase === "running" || t.phase === "pending",
    );

    return html`
      <div class="board-page">
        <div class="board-main">
          <div class="page-header">
            <div>
              <h1>Activity</h1>
              <p>${subtitle}</p>
            </div>
            <div class="spacer"></div>
          </div>

          ${
            s.connectionError && s.tasks.length === 0
              ? html`
                  <div
                    class="card highlight pad row problem"
                    style="--tint:var(--danger)"
                  >
                    ${icon("unplug", 26, { color: "var(--danger)" })}
                    <div class="col" style="flex:1;min-width:0">
                      <strong>Can't reach the AX control plane</strong>
                      <span class="muted selectable">${s.connectionError}</span>
                    </div>
                    <button
                      class="btn"
                      @click=${() => store.setSection("clusters")}
                    >
                      Open Clusters
                    </button>
                  </div>
                `
              : nothing
          }
          ${this.renderDigest()}

          <div class="row board-head" id="task-board">
            <h2>Tasks</h2>
            ${
              s.tasks.length > 0
                ? html`<span class="caption faint"
                    >Click a column to sort. Right-click a task for
                    actions.</span
                  >`
                : nothing
            }
            <span class="spacer"></span>
            ${
              resumable.length >= 2
                ? html`
                    <button
                      class="btn small primary"
                      @click=${() => void store.resumeAll(resumable)}
                    >
                      ${icon("play", 12)} Resume All (${resumable.length})
                    </button>
                  `
                : nothing
            }
            ${
              suspendable.length >= 2
                ? html`
                    <button
                      class="btn small"
                      @click=${() => void store.suspendAll(suspendable)}
                    >
                      ${icon("pause", 12)} Suspend All (${suspendable.length})
                    </button>
                  `
                : nothing
            }
          </div>

          ${
            s.tasks.length === 0
              ? html`
                  <div class="card board-empty">
                    <div class="empty">
                      ${icon("rows", 28)}
                      <div
                        style="font-weight:600;color:var(--on-surface-variant)"
                      >
                        No tasks in this atespace
                      </div>
                      <div class="caption">
                        <button
                          class="btn small"
                          style="margin-top:8px"
                          @click=${() => store.setSection("designer")}
                        >
                          ${icon("plus", 12)} Deploy a task
                        </button>
                      </div>
                    </div>
                  </div>
                `
              : html`
                  <div class="card task-table-wrap">
                    <table class="task-table" aria-label="Tasks">
                      <thead>
                        <tr>
                          ${COLUMNS.map(
                            (c) => html`
                              <th
                                class="col-${c.key} ${
                                  this.sort.key === c.key ? "sorted" : ""
                                }"
                                aria-sort=${
                                  this.sort.key === c.key
                                    ? this.sort.dir === 1
                                      ? "ascending"
                                      : "descending"
                                    : "none"
                                }
                              >
                                <button
                                  class="th-sort"
                                  @click=${() => this.onSort(c.key)}
                                >
                                  ${c.title}
                                  ${
                                    this.sort.key === c.key
                                      ? icon(
                                          this.sort.dir === 1
                                            ? "arrow-up"
                                            : "arrow-down",
                                          11,
                                        )
                                      : icon("arrow-up-down", 11, {
                                          className: "th-idle",
                                        })
                                  }
                                </button>
                              </th>
                            `,
                          )}
                          <th class="col-actions">
                            <span class="sr">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        ${tasks.map((t) => {
                          const selected = t.id === s.selectedTaskID;
                          const detail = s.details[t.id];
                          return html`
                            <tr
                              class="task-row ${selected ? "selected" : ""}"
                              style="--c:${phaseColor(t.phase)}"
                              @click=${() =>
                                store.set({
                                  selectedTaskID: selected ? null : t.id,
                                })}
                              @contextmenu=${(e: MouseEvent) => {
                                e.preventDefault();
                                this.menu = {
                                  task: t,
                                  x: e.clientX,
                                  y: e.clientY,
                                };
                              }}
                            >
                              <td class="col-name">
                                <span
                                  class="task-row-name ellipsis"
                                  title=${t.name}
                                  ><bdi dir="ltr">${t.name}</bdi></span
                                >
                              </td>
                              <td class="col-state">
                                ${renderPhaseBadge(t.phase)}
                              </td>
                              <td class="col-workspace">
                                ${
                                  detail?.workspace
                                    ? html`<span class="row task-row-ws">
                                        ${icon("folder-git", 12, {
                                          color: "var(--purple)",
                                        })}
                                        <span class="ellipsis"
                                          ><bdi dir="ltr"
                                            >${detail.workspace}</bdi
                                          ></span
                                        >
                                      </span>`
                                    : html`<span class="faint"
                                        >empty /workspace</span
                                      >`
                                }
                              </td>
                              <td
                                class="col-image mono ellipsis"
                                title=${detail?.image ?? ""}
                              >
                                ${
                                  detail?.image
                                    ? html`<bdi dir="ltr"
                                        >${shortImage(detail.image)}</bdi
                                      >`
                                    : html`<span class="faint">–</span>`
                                }
                              </td>
                              <td class="col-worker mono">
                                ${
                                  t.workerIP
                                    ? html`<bdi dir="ltr"
                                        >${t.workerIP.split(":")[0]}</bdi
                                      >`
                                    : html`<span class="faint">–</span>`
                                }
                              </td>
                              <td
                                class="col-age num"
                                title=${detail?.createTime ?? ""}
                              >
                                ${t.age}
                              </td>
                              <td class="col-actions">
                                <div
                                  class="task-row-actions"
                                  @click=${(e: Event) => e.stopPropagation()}
                                >
                                  ${actionsForTask(
                                    t,
                                    () => {
                                      this.confirmTask = t;
                                    },
                                    () => {
                                      this.movingTask = t;
                                    },
                                  ).map(
                                    (a) => html`
                                      <button
                                        class="btn ghost small icon ${
                                          a.danger ? "danger" : ""
                                        }"
                                        title=${a.label.replace("…", "")}
                                        aria-label="${a.label.replace(
                                          "…",
                                          "",
                                        )} ${t.name}"
                                        @click=${a.run}
                                      >
                                        ${icon(a.iconName, 12)}
                                      </button>
                                    `,
                                  )}
                                </div>
                              </td>
                            </tr>
                          `;
                        })}
                      </tbody>
                    </table>
                  </div>
                `
          }
          ${this.renderWorkspaces()} ${this.renderSnapshots()}
        </div>

        <ax-task-inspector></ax-task-inspector>

        ${
          this.menu
            ? html`
                <div
                  class="menu card fade-in board-menu"
                  style="left:${Math.min(
                    this.menu.x,
                    window.innerWidth - 220,
                  )}px;top:${Math.min(this.menu.y, window.innerHeight - 160)}px"
                  @mousedown=${(e: Event) => e.stopPropagation()}
                >
                  ${actionsForTask(
                    this.menu.task,
                    () => {
                      this.confirmTask = this.menu?.task ?? null;
                    },
                    () => {
                      this.movingTask = this.menu?.task ?? null;
                    },
                  ).map(
                    (a) => html`
                      <button
                        class="menu-item"
                        style=${a.danger ? "color:var(--danger)" : ""}
                        @click=${() => {
                          a.run();
                          this.menu = null;
                        }}
                      >
                        <span class="menu-check">${icon(a.iconName, 13)}</span>
                        ${a.label}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing
        }
        ${
          this.confirmTask
            ? renderDeleteTaskModal(this.confirmTask, () => {
                this.confirmTask = null;
              })
            : nothing
        }
        ${
          this.movingTask
            ? html`<ax-move-task-modal
                .task=${this.movingTask}
                .onClose=${() => {
                  this.movingTask = null;
                }}
              ></ax-move-task-modal>`
            : nothing
        }
        ${
          this.confirmWorkspace
            ? this.renderDeleteWorkspaceModal(this.confirmWorkspace)
            : nothing
        }
        ${
          this.activeSnapshot
            ? this.renderSnapshotModal(this.activeSnapshot)
            : nothing
        }
      </div>
    `;
  }

  private async openSnapshot(snap: WorkspaceSnapshot): Promise<void> {
    this.activeSnapshot = snap;
    this.loadingSnapshot = true;
    this.snapshotFiles = [];
    this.snapshotPreviews = {};
    this.selectedSnapshotFile = null;
    const res = await store.inspectSnapshot(snap);
    if (this.activeSnapshot?.path === snap.path) {
      this.snapshotFiles = res.files;
      this.snapshotPreviews = res.previews;
      const preferred =
        res.files.find((f) =>
          /DECISION|REPORT|review|output|audit|migrated/i.test(f),
        ) ??
        res.files[0] ??
        null;
      this.selectedSnapshotFile = preferred;
      this.loadingSnapshot = false;
    }
  }

  private renderSnapshots() {
    const s = store.state;
    if (!isLocalContext(s.context) || s.snapshots.length === 0) {
      return nothing;
    }
    const formatBytes = (b: number) =>
      b >= 1024 * 1024
        ? `${(b / (1024 * 1024)).toFixed(1)} MB`
        : b >= 1024
          ? `${(b / 1024).toFixed(1)} KB`
          : `${b} B`;

    return html`
      <div class="row board-head" style="margin-top:18px" id="snapshot-board">
        <h2>Workspace Snapshots</h2>
        <span class="caption faint">
          Persisted <code>.ax-local/snapshots/${s.atespace}/*.tar.gz</code>
          archives (preserved even after containers are deleted).
        </span>
      </div>
      <div class="card task-table-wrap">
        <table class="task-table" aria-label="Workspace snapshots">
          <thead>
            <tr>
              <th class="col-name">
                <span class="th-label">Task Archive</span>
              </th>
              <th class="col-repos">
                <span class="th-label">Status</span>
              </th>
              <th class="col-mcp">
                <span class="th-label">Size</span>
              </th>
              <th class="col-files">
                <span class="th-label">Saved At</span>
              </th>
              <th class="col-actions">
                <span class="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            ${s.snapshots.map((snap) => {
              const liveTask = s.tasks.find((t) => t.name === snap.name);
              return html`
                <tr class="task-row" style="--c:var(--teal)">
                  <td class="col-name">
                    <span class="row task-row-ws">
                      ${icon("save", 13, { color: "var(--teal)" })}
                      <span class="task-row-name ellipsis" title=${snap.path}
                        ><bdi dir="ltr">${snap.name}.tar.gz</bdi></span
                      >
                    </span>
                  </td>
                  <td class="col-repos">
                    ${
                      liveTask
                        ? renderPhaseBadge(liveTask.phase)
                        : html`<span class="caption faint"
                            >Post-mortem archive (task deleted)</span
                          >`
                    }
                  </td>
                  <td class="col-mcp num">${formatBytes(snap.sizeBytes)}</td>
                  <td class="col-files mono">${snap.updatedAt}</td>
                  <td class="col-actions">
                    <div class="task-row-actions">
                      <button
                        class="btn small ghost"
                        title="Browse and read files inside ${snap.name}.tar.gz"
                        aria-label="Inspect snapshot ${snap.name}"
                        @click=${() => void this.openSnapshot(snap)}
                      >
                        ${icon("eye", 12)} Inspect
                      </button>
                      <button
                        class="btn ghost small icon danger"
                        title="Delete snapshot archive"
                        aria-label="Delete snapshot ${snap.name}"
                        @click=${() => void store.removeSnapshot(snap)}
                      >
                        ${icon("trash", 12)}
                      </button>
                    </div>
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderSnapshotModal(snap: WorkspaceSnapshot) {
    const close = () => {
      this.activeSnapshot = null;
    };
    const fileContent =
      (this.selectedSnapshotFile &&
        this.snapshotPreviews[this.selectedSnapshotFile]) ||
      "";
    return html`
      <div class="modal-backdrop" @mousedown=${close}>
        <div
          class="modal card fade-in snap-modal"
          role="dialog"
          aria-label="Inspect workspace snapshot"
          @mousedown=${(e: Event) => e.stopPropagation()}
        >
          <div class="row" style="margin-bottom:10px">
            ${icon("save", 16, { color: "var(--teal)" })}
            <h3 style="margin:0">
              Snapshot “<bdi dir="ltr">${snap.name}.tar.gz</bdi>”
            </h3>
            <span class="caption faint">${snap.updatedAt}</span>
            <span class="spacer"></span>
            <button
              class="btn small ghost icon"
              aria-label="Close snapshot inspector"
              @click=${close}
            >
              ${icon("x", 15)}
            </button>
          </div>
          <p class="caption faint mono" style="margin:0 0 12px">
            <bdi dir="ltr">${snap.path}</bdi>
          </p>
          ${
            this.loadingSnapshot
              ? html`<div class="empty" style="padding:24px">
                  <span class="faint">Reading archive contents…</span>
                </div>`
              : this.snapshotFiles.length === 0
                ? html`<div class="empty" style="padding:24px">
                    <span class="faint">No files found in archive.</span>
                  </div>`
                : html`
                    <div class="snap-grid">
                      <div
                        class="snap-files"
                        role="listbox"
                        aria-label="Snapshot files"
                      >
                        ${this.snapshotFiles.map(
                          (f) => html`
                            <button
                              class="snap-file-btn ${
                                f === this.selectedSnapshotFile ? "active" : ""
                              }"
                              role="option"
                              aria-selected=${
                                f === this.selectedSnapshotFile
                                  ? "true"
                                  : "false"
                              }
                              @click=${() => (this.selectedSnapshotFile = f)}
                            >
                              ${icon("file-text", 12, { color: "var(--teal)" })}
                              <span class="ellipsis"
                                ><bdi dir="ltr">${f}</bdi></span
                              >
                            </button>
                          `,
                        )}
                      </div>
                      <div class="snap-preview selectable">
                        <div class="row snap-preview-head">
                          <strong class="mono ellipsis"
                            ><bdi dir="ltr"
                              >${this.selectedSnapshotFile ?? ""}</bdi
                            ></strong
                          >
                          <span class="spacer"></span>
                          ${
                            fileContent
                              ? html`<button
                                  class="btn small ghost"
                                  @click=${() =>
                                    void navigator.clipboard.writeText(
                                      fileContent,
                                    )}
                                >
                                  ${icon("copy", 12)} Copy
                                </button>`
                              : nothing
                          }
                        </div>
                        <pre class="snap-code">
${
                            fileContent ||
                            "(Binary or >32 KiB file — inspect archive directly on disk)"
                          }</pre>
                      </div>
                    </div>
                  `
          }
        </div>
      </div>
    `;
  }

  private renderDeleteWorkspaceModal(ws: AXWorkspace) {
    const users = store.tasksUsing(ws.name);
    const close = () => {
      this.confirmWorkspace = null;
    };
    return html`
      <div class="modal-backdrop" @mousedown=${close}>
        <div
          class="modal card fade-in"
          role="dialog"
          aria-label="Delete workspace"
          @mousedown=${(e: Event) => e.stopPropagation()}
        >
          <h3>Delete workspace “${ws.name}”?</h3>
          <p class="muted" style="margin:0 0 18px;line-height:1.5">
            It's removed from <strong>${ws.atespace}</strong>. This can't be
            undone.
            ${
              users.length > 0
                ? html`
                    ${users.length === 1 ? "Task" : "Tasks"}
                    <strong>${users.map((t) => t.name).join(", ")}</strong>
                    ${users.length === 1 ? "uses" : "use"} it.
                  `
                : nothing
            }
          </p>
          <div class="row" style="justify-content:flex-end">
            <button class="btn" @click=${close}>Cancel</button>
            <button
              class="btn primary danger"
              @click=${() => {
                close();
                void store.remove("workspace", ws.name);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        height: 100%;
      }
      .pad {
        padding: 16px;
      }
      .problem {
        gap: 14px;
        margin-bottom: 16px;
      }
      .board-page {
        display: flex;
        height: 100%;
        min-width: 0;
        position: relative;
      }
      .board-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        padding: 24px 28px 20px;
      }
      .board-head {
        gap: 12px;
        align-items: baseline;
        margin: 4px 0 10px;
      }
      .board-head h2 {
        margin: 0;
        font-family: var(--font-display);
        font-size: 17px;
        font-weight: 650;
      }
      .board-empty {
        padding: 16px;
        margin-bottom: 16px;
      }

      /* Digest */
      .digest {
        display: flex;
        align-items: center;
        gap: 20px;
        padding: 14px 18px;
        margin-bottom: 18px;
        flex: none;
        flex-wrap: wrap;
      }
      .digest button {
        font: inherit;
        color: inherit;
        background: none;
        border: 0;
        padding: 0;
        cursor: pointer;
      }
      .digest-divider {
        width: 1px;
        align-self: stretch;
        background: var(--border);
      }
      .digest-tasks {
        display: flex;
        align-items: center;
        gap: 18px;
        flex: 1;
        min-width: 240px;
      }
      .digest-total {
        display: flex;
        align-items: baseline;
        gap: 6px;
      }
      .digest-value {
        font-family: var(--font-display);
        font-size: 30px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .digest-phases {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .digest-chips {
        gap: 14px;
        flex-wrap: wrap;
        font-size: 12.5px;
      }
      .digest-chip {
        gap: 5px;
      }
      .digest-bar {
        display: flex;
        gap: 2px;
        height: 6px;
      }
      .digest-bar > div {
        min-width: 4px;
        border-radius: 3px;
        transition: flex-grow var(--duration-slow) var(--easing-standard);
      }
      .digest-spark {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: none;
      }
      .digest-spark svg {
        display: block;
      }
      .digest-spark-empty {
        width: 180px;
        height: 40px;
        display: flex;
        align-items: center;
        font-size: 12px;
      }
      .digest-side {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 260px;
        flex: none;
        font-size: 12.5px;
      }
      .digest-link {
        gap: 5px;
      }
      .digest-link:hover .muted {
        color: var(--on-surface);
      }
      .digest-activity {
        gap: 6px;
        min-width: 0;
      }
      .digest-activity .ellipsis {
        flex: 1;
        min-width: 0;
      }

      /* Table */
      .task-table-wrap {
        padding: 0;
        overflow: auto;
        margin-bottom: 8px;
      }
      .task-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        table-layout: fixed;
        font-size: 12.5px;
      }
      .task-table th {
        position: sticky;
        top: 0;
        z-index: 1;
        text-align: left;
        font-weight: 600;
        font-size: 11px;
        color: var(--text-3);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--surface-bright);
        border-bottom: 1px solid var(--border);
        padding: 0;
      }
      .th-sort {
        all: unset;
        box-sizing: border-box;
        width: 100%;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 9px 12px;
        cursor: pointer;
      }
      .th-sort:hover {
        color: var(--on-surface);
      }
      .task-table th.sorted {
        color: var(--on-surface);
      }
      .th-idle {
        opacity: 0;
        transition: opacity var(--duration-fast);
      }
      .th-sort:hover .th-idle {
        opacity: 0.6;
      }
      .task-table td {
        padding: 8px 12px;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: middle;
      }
      .task-table tr:last-child td {
        border-bottom: none;
      }
      .task-table .mono {
        font-size: 11.5px;
        color: var(--on-surface-variant);
      }
      .col-name {
        width: 28%;
      }
      .col-state {
        width: 120px;
      }
      .col-workspace {
        width: 18%;
      }
      .col-image {
        width: 18%;
      }
      .col-worker {
        width: 110px;
      }
      .col-age {
        width: 70px;
        color: var(--on-surface-variant);
      }
      .col-actions {
        width: 136px;
      }
      .snap-modal {
        width: 720px;
        max-width: calc(100vw - 32px);
      }
      .snap-grid {
        display: grid;
        grid-template-columns: 220px minmax(0, 1fr);
        gap: 12px;
        height: 360px;
      }
      .snap-files {
        border: 1px solid var(--border);
        border-radius: var(--radius-s);
        background: var(--surface-container);
        padding: 6px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .snap-file-btn {
        border: 0;
        background: transparent;
        color: var(--on-surface-variant);
        font: inherit;
        font-size: 12px;
        padding: 6px 8px;
        border-radius: var(--radius-xs);
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        text-align: left;
      }
      .snap-file-btn:hover {
        background: var(--state-hover);
        color: var(--on-surface);
      }
      .snap-file-btn.active {
        background: var(--accent-soft);
        color: var(--on-surface);
        font-weight: 600;
      }
      .snap-preview {
        border: 1px solid var(--border);
        border-radius: var(--radius-s);
        background: var(--surface-container);
        display: flex;
        flex-direction: column;
        min-width: 0;
        overflow: hidden;
      }
      .snap-preview-head {
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        font-size: 12px;
      }
      .snap-code {
        margin: 0;
        padding: 10px 12px;
        font-family: var(--font-mono);
        font-size: 11.5px;
        line-height: 1.45;
        overflow: auto;
        flex: 1;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .col-repos {
        width: 24%;
      }
      .col-mcp {
        width: 18%;
      }
      .col-files {
        width: 16%;
      }
      .col-used {
        width: 70px;
        color: var(--on-surface-variant);
      }
      .th-label {
        display: inline-block;
        padding: 9px 12px;
      }
      .task-row {
        cursor: pointer;
        transition: background var(--duration-fast);
      }
      .task-row td:first-child {
        box-shadow: inset 3px 0 0 var(--c);
      }
      .task-row:hover td {
        background: var(--surface-container-low);
      }
      .task-row.selected td {
        background: var(--accent-soft);
      }
      .task-row-name {
        display: block;
        font-weight: 600;
      }
      .task-row-ws {
        gap: 5px;
        min-width: 0;
      }
      .task-row-actions {
        display: flex;
        justify-content: flex-end;
        gap: 2px;
        opacity: 0;
        transition: opacity var(--duration-fast);
      }
      .task-row:hover .task-row-actions,
      .task-row.selected .task-row-actions,
      .task-row:focus-within .task-row-actions {
        opacity: 1;
      }
      .board-menu {
        position: fixed;
        right: auto;
        top: 0;
        min-width: 180px;
        z-index: 60;
      }
    `,
  ];
}
