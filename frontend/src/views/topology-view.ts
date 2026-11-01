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
import { customElement, state } from "lit/decorators.js";
import { type IconName, icon, renderPhaseIcon } from "../icons";
import {
  type AXTask,
  type AXWorkspace,
  type GitRepo,
  type Phase,
  phaseColor,
  phaseLabel,
  repoName,
} from "../model/resources";
import { type State, store } from "../model/store";
import { sharedStyles } from "../shared-styles";
import "./overview-view";

type Kind =
  | { type: "repo"; repo: GitRepo }
  | { type: "mcp"; name: string; endpoint: string }
  | { type: "workspace"; ws: AXWorkspace | null }
  | { type: "task"; task: AXTask };

interface GraphNode {
  id: string;
  kind: Kind;
  x: number;
  y: number;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  d: string;
  color: string;
  flowing: boolean;
}

const NODE_W = 200;
const NODE_H = 56;
const ROW_H = 76;
const GROUP_GAP = 26;
const TOP = 40;
const COLUMN_X = [130, 420, 720];
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

function curve(ax: number, ay: number, bx: number, by: number): string {
  const dx = Math.max(40, (bx - ax) / 2);
  return `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
}

function layoutGraph(s: State) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let y = TOP;

  const tasksUsing = (ws: string) =>
    s.tasks.filter((t) => s.details[t.id]?.workspace === ws);
  const groups: { ws: AXWorkspace | null; tasks: AXTask[] }[] =
    s.workspaces.map((ws) => ({ ws, tasks: tasksUsing(ws.name) }));
  const unbound = s.tasks.filter((t) => {
    const w = s.details[t.id]?.workspace;
    return !w || !s.workspaces.some((ws) => ws.name === w);
  });
  if (unbound.length) groups.push({ ws: null, tasks: unbound });

  for (const g of groups) {
    const sources: Kind[] = [
      ...(g.ws?.repos.map((repo): Kind => ({ type: "repo", repo })) ?? []),
      ...(g.ws?.mcpServers.map((m): Kind => ({
        type: "mcp",
        name: m.name,
        endpoint: m.endpoint,
      })) ?? []),
    ];
    const rows = Math.max(sources.length, g.tasks.length, 1);
    const height = rows * ROW_H;
    const wsID = `ws:${g.ws?.name ?? "-"}`;
    const wsY = y + height / 2;
    nodes.push({
      id: wsID,
      kind: { type: "workspace", ws: g.ws },
      x: COLUMN_X[1],
      y: wsY,
    });
    const stackY = (i: number, n: number) =>
      y + height / 2 + (i - (n - 1) / 2) * ROW_H;

    sources.forEach((src, i) => {
      const id =
        src.type === "repo"
          ? `repo:${wsID}:${src.repo.name}:${src.repo.repo}`
          : `mcp:${wsID}:${src.type === "mcp" ? src.name : i}`;
      const cy = stackY(i, sources.length);
      nodes.push({ id, kind: src, x: COLUMN_X[0], y: cy });
      edges.push({
        id: `${id}->${wsID}`,
        from: id,
        to: wsID,
        d: curve(COLUMN_X[0] + NODE_W / 2, cy, COLUMN_X[1] - NODE_W / 2, wsY),
        color: "var(--purple)",
        flowing: false,
      });
    });
    g.tasks.forEach((t, i) => {
      const id = `task:${t.id}`;
      const cy = stackY(i, g.tasks.length);
      nodes.push({
        id,
        kind: { type: "task", task: t },
        x: COLUMN_X[2],
        y: cy,
      });
      edges.push({
        id: `${wsID}->${id}`,
        from: wsID,
        to: id,
        d: curve(COLUMN_X[1] + NODE_W / 2, wsY, COLUMN_X[2] - NODE_W / 2, cy),
        color: phaseColor(t.phase),
        flowing: t.phase === "running",
      });
    });
    y += height + GROUP_GAP;
  }

  const left = nodes.length
    ? Math.min(...nodes.map((n) => n.x)) - NODE_W / 2 - 30
    : 0;
  const width = COLUMN_X[COLUMN_X.length - 1] + NODE_W / 2 + 30 - left;
  return { nodes, edges, left, width, height: y + 20 };
}

function describeNode(k: Kind): {
  iconName: IconName;
  tint: string;
  title: string;
  subtitle: string;
  tooltip: string;
} {
  switch (k.type) {
    case "repo":
      return {
        iconName: "git-branch",
        tint: "var(--orange)",
        title: repoName(k.repo.repo),
        subtitle: `${k.repo.branch} · ${k.repo.name}`,
        tooltip: k.repo.repo,
      };
    case "mcp":
      return {
        iconName: "plug",
        tint: "var(--danger)",
        title: k.name,
        subtitle: "MCP server",
        tooltip: k.endpoint,
      };
    case "workspace": {
      if (!k.ws)
        return {
          iconName: "folder-open",
          tint: "var(--text-3)",
          title: "empty /workspace",
          subtitle: "tasks without a workspace",
          tooltip: "Tasks with no Workspace start in an empty /workspace",
        };
      const n = k.ws.repos.length || k.ws.gitCount;
      const m = k.ws.mcpServers.length || k.ws.mcpCount;
      return {
        iconName: "folder-git",
        tint: "var(--purple)",
        title: k.ws.name,
        subtitle: `${n} repo${n === 1 ? "" : "s"} · ${m} MCP`,
        tooltip: k.ws.name,
      };
    }
    case "task":
      return {
        iconName: "box",
        tint: phaseColor(k.task.phase),
        title: k.task.name,
        subtitle: `${phaseLabel(k.task.phase)} · ${k.task.age}`,
        tooltip: `${k.task.name} — click for details`,
      };
  }
}

const LEGEND: Phase[] = ["running", "pending", "suspended", "failed"];

@customElement("ax-topology")
export class AxTopology extends LitElement {
  @state() private hover: string | null = null;
  @state() private zoom = 1;
  private offStore: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.offStore = store.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offStore?.();
  }

  private onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    this.zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, this.zoom * Math.exp(-e.deltaY * 0.01)),
    );
  };

  private computeLit(edges: GraphEdge[]): Set<string> | null {
    if (!this.hover) return null;
    const set = new Set([this.hover]);
    for (const e of edges) {
      if (e.from === this.hover) set.add(e.to);
      if (e.to === this.hover) set.add(e.from);
    }
    if (this.hover.startsWith("repo:") || this.hover.startsWith("mcp:")) {
      for (const e of edges)
        if (e.from.startsWith("ws:") && set.has(e.from)) set.add(e.to);
    } else if (this.hover.startsWith("task:")) {
      for (const e of edges)
        if (e.to.startsWith("ws:") && set.has(e.to)) set.add(e.from);
    }
    return set;
  }

  override render() {
    const s = store.state;
    const graph = layoutGraph(s);
    const lit = this.computeLit(graph.edges);
    const edgeLit = (e: GraphEdge) =>
      !lit || (lit.has(e.from) && lit.has(e.to));
    const empty = s.tasks.length === 0 && s.workspaces.length === 0;

    return html`
      <div class="topology-page">
        <div class="topology">
          <div class="topology-head">
            <div class="page-header">
              <div>
                <h1>Map</h1>
                <p>
                  How sources feed workspaces and workspaces feed tasks. Running
                  edges flow.
                </p>
              </div>
              <div class="spacer"></div>
              <div class="row topo-legend">
                ${LEGEND.map(
                  (p) => html`
                    <span class="row" style="gap:4px">
                      ${renderPhaseIcon(p, 12)}
                      <span class="caption muted">${phaseLabel(p)}</span>
                    </span>
                  `,
                )}
                <input
                  type="range"
                  min=${MIN_ZOOM}
                  max=${MAX_ZOOM}
                  step="0.05"
                  .value=${String(this.zoom)}
                  aria-label="Zoom"
                  title="Zoom ${Math.round(this.zoom * 100)}% (pinch to zoom, double-click to reset)"
                  style="width:120px;margin-left:8px"
                  @input=${(e: Event) =>
                    (this.zoom = +(e.target as HTMLInputElement).value)}
                />
              </div>
            </div>
          </div>

          <div
            class="topo-scroll dotgrid"
            tabindex="0"
            role="region"
            aria-label="Topology map"
            @wheel=${this.onWheel}
            @dblclick=${(e: MouseEvent) => {
              if (!(e.target as HTMLElement).closest(".topo-node"))
                this.zoom = 1;
            }}
          >
            ${
              empty
                ? html`
                    <div class="empty">
                      ${icon("network", 28)}
                      <div
                        style="font-weight:600;color:var(--on-surface-variant)"
                      >
                        Nothing to draw yet
                      </div>
                      <div class="caption">
                        Create a Workspace or Task in Deploy to see it here.
                      </div>
                    </div>
                  `
                : html`
                    <div
                      class="topo-sizer"
                      style="width:${
                        graph.width * this.zoom
                      }px;height:${graph.height * this.zoom}px"
                    >
                      <div
                        class="topo-canvas"
                        style="width:${graph.width}px;height:${graph.height}px;transform:scale(${
                          this.zoom
                        }) translateX(${-graph.left}px)"
                      >
                        <svg
                          class="topo-edges"
                          width=${graph.width + graph.left}
                          height=${graph.height}
                          aria-hidden="true"
                        >
                          <g>
                            ${graph.edges.map(
                              (e) => svg`
                              <g class="topo-edge" style="opacity:${edgeLit(e) ? 1 : 0.15}">
                                <path
                                  d=${e.d}
                                  fill="none"
                                  stroke=${e.color}
                                  stroke-opacity=${e.color === "var(--purple)" ? 0.55 : 0.8}
                                  stroke-width=${lit && edgeLit(e) ? 2.5 : 1.6}
                                />
                                ${
                                  e.flowing
                                    ? [0, 0.55, 1.1].map(
                                        (delay) => svg`
                                          <circle r="3.2" fill=${e.color}>
                                            <animateMotion
                                              dur="1.65s"
                                              begin="${delay}s"
                                              repeatCount="indefinite"
                                              path=${e.d}
                                            />
                                          </circle>
                                        `,
                                      )
                                    : nothing
                                }
                              </g>
                            `,
                            )}
                          </g>
                        </svg>

                        ${graph.nodes.map((n) => {
                          const d = describeNode(n.kind);
                          const task =
                            n.kind.type === "task" ? n.kind.task : null;
                          return html`
                            <div
                              class="topo-node card ${
                                task ? "clickable" : ""
                              } ${this.hover === n.id ? "hovered" : ""} ${
                                task && task.id === s.selectedTaskID
                                  ? "selected"
                                  : ""
                              }"
                              title=${d.tooltip}
                              style="left:${n.x - NODE_W / 2}px;top:${
                                n.y - NODE_H / 2
                              }px;width:${NODE_W}px;height:${NODE_H}px;opacity:${
                                !lit || lit.has(n.id) ? 1 : 0.25
                              };--tint:${d.tint}"
                              @mouseenter=${() => (this.hover = n.id)}
                              @mouseleave=${() => {
                                if (this.hover === n.id) this.hover = null;
                              }}
                              @click=${() => {
                                if (task) {
                                  store.set({
                                    selectedTaskID:
                                      task.id === s.selectedTaskID
                                        ? null
                                        : task.id,
                                  });
                                }
                              }}
                            >
                              <div class="topo-icon">
                                ${icon(d.iconName, 16, { color: d.tint })}
                              </div>
                              <div class="col topo-text">
                                <div class="topo-title ellipsis">
                                  <bdi dir="ltr">${d.title}</bdi>
                                </div>
                                <div class="topo-sub ellipsis">
                                  ${d.subtitle}
                                </div>
                              </div>
                              ${task ? renderPhaseIcon(task.phase, 13) : nothing}
                            </div>
                          `;
                        })}
                      </div>
                    </div>
                  `
            }
          </div>
        </div>
        <ax-task-inspector></ax-task-inspector>
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
      .topology-page {
        display: flex;
        height: 100%;
        min-width: 0;
      }
      .topology {
        flex: 1;
        min-width: 0;
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      .topology-head {
        padding: 24px 28px 0;
        flex: none;
      }
      .topology-head .page-header {
        margin-bottom: 12px;
      }
      .topo-legend {
        gap: 12px;
      }
      .topo-scroll {
        flex: 1;
        min-height: 0;
        overflow: auto;
        border-top: 1px solid var(--border);
        position: relative;
      }
      .topo-sizer {
        position: relative;
        margin: 8px auto 24px;
      }
      .topo-canvas {
        position: absolute;
        left: 0;
        top: 0;
        transform-origin: 0 0;
      }
      .topo-edges {
        position: absolute;
        left: 0;
        top: 0;
        pointer-events: none;
        overflow: visible;
      }
      .topo-edge {
        transition: opacity var(--duration-fast) var(--easing-standard);
      }
      .topo-node {
        position: absolute;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 12px 0 10px;
        transition:
          opacity var(--duration-fast) var(--easing-standard),
          box-shadow var(--duration-fast) var(--easing-standard),
          transform var(--duration-fast) var(--easing-standard);
      }
      .topo-node.hovered {
        box-shadow:
          0 0 0 3px color-mix(in srgb, var(--tint) 18%, transparent),
          var(--shadow-2);
        transform: translateY(-1px);
      }
      .topo-node.clickable {
        cursor: pointer;
      }
      .topo-node.selected {
        box-shadow:
          0 0 0 2px var(--tint),
          var(--shadow-2);
      }
      .topo-icon {
        width: 32px;
        height: 32px;
        border-radius: var(--radius-s);
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--tint) 14%, transparent);
      }
      .topo-text {
        min-width: 0;
        flex: 1;
        gap: 1px;
      }
      .topo-title {
        font-weight: 600;
        font-size: 13px;
      }
      .topo-sub {
        font-size: 11px;
        color: var(--on-surface-variant);
      }
    `,
  ];
}
