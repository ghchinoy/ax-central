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
import { customElement, query, state } from "lit/decorators.js";
import { type IconName, icon } from "../icons";
import {
  type Cluster,
  type ConsoleLine,
  type Operation,
  type Replicas,
  STAGES,
  clusters,
} from "../model/clusters";
import { store } from "../model/store";
import { sharedStyles } from "../shared-styles";

type Health = "ok" | "warn" | "fail" | "none";

const HEALTH: Record<Health, { iconName: IconName; color: string }> = {
  ok: { iconName: "circle-check", color: "var(--green)" },
  warn: { iconName: "circle-dashed", color: "var(--warn)" },
  fail: { iconName: "circle-x", color: "var(--danger)" },
  none: { iconName: "circle", color: "var(--text-3)" },
};

const full = (r: Replicas) => !!r && r.total > 0 && r.ready >= r.total;

function layersFor(c: Cluster): {
  id: string;
  iconName: IconName;
  title: string;
  detail: string;
  health: Health;
}[] {
  const kind: Health = !c.reachable ? "fail" : full(c.nodes) ? "ok" : "warn";
  const substrate: Health =
    !c.reachable || !c.substrate ? "none" : full(c.substrate) ? "ok" : "warn";
  const ax: Health =
    !c.reachable || !c.ax
      ? "none"
      : full(c.ax) && (!c.workers || full(c.workers))
        ? "ok"
        : "warn";
  return [
    {
      id: "ax",
      iconName: "server",
      title: "AX",
      health: ax,
      detail: !c.ax
        ? "Not installed"
        : `ax-server ${c.ax.ready}/${c.ax.total}${c.workers ? ` · ${c.workers.ready}/${c.workers.total} gVisor workers` : ""}`,
    },
    {
      id: "substrate",
      iconName: "layers",
      title: "Agent Substrate",
      health: substrate,
      detail: !c.substrate
        ? "Not installed"
        : `ate-api-server ${c.substrate.ready}/${c.substrate.total}${c.substrateCommit ? ` · ${c.substrateCommit.slice(0, 7)}` : ""}`,
    },
    {
      id: "kind",
      iconName: "cpu",
      title: "Kind",
      health: kind,
      detail: !c.reachable
        ? "Unreachable; is the container runtime running?"
        : `${c.nodes?.ready ?? 0}/${c.nodes?.total ?? 0} nodes Ready${c.version ? ` · Kubernetes ${c.version.replace(/^v/, "")}` : ""}`,
    },
  ];
}

@customElement("ax-clusters")
export class AxClusters extends LitElement {
  @state() private selected: string | null = new URLSearchParams(
    location.search,
  ).get("cluster");
  @state() private outputOpen = false;
  @state() private copiedCmd = "";
  @query(".console-body") private consoleBody?: HTMLElement;

  private stickConsole = true;
  private offClusters: (() => void) | null = null;
  private offStore: (() => void) | null = null;
  private opTick: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.offClusters = clusters.subscribe(() => {
      if (clusters.running) this.outputOpen = true;
      this.syncOpTimer();
      this.requestUpdate();
    });
    this.offStore = store.subscribe(() => this.requestUpdate());
    void clusters.init();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offClusters?.();
    this.offStore?.();
    if (this.opTick) clearInterval(this.opTick);
  }

  override updated(_changed: PropertyValues<this>): void {
    if (this.stickConsole && this.consoleBody) {
      this.consoleBody.scrollTop = this.consoleBody.scrollHeight;
    }
  }

  private syncOpTimer(): void {
    if (clusters.running && !this.opTick) {
      this.opTick = setInterval(() => this.requestUpdate(), 1000);
    } else if (!clusters.running && this.opTick) {
      clearInterval(this.opTick);
      this.opTick = null;
    }
  }

  private renderOverall(rows: ReturnType<typeof layersFor>): TemplateResult {
    const [ax, substrate, kind] = rows.map((r) => r.health);
    const v =
      kind === "fail"
        ? { h: "fail" as Health, label: "Unreachable" }
        : ax === "ok" && substrate === "ok" && kind === "ok"
          ? { h: "ok" as Health, label: "Ready" }
          : rows.some((r) => r.health === "warn")
            ? { h: "warn" as Health, label: "Starting" }
            : substrate === "none"
              ? { h: "none" as Health, label: "Kubernetes only" }
              : { h: "none" as Health, label: "No AX" };
    const h = HEALTH[v.h];
    return html`
      <span class="badge" style="--c:${h.color}">
        ${icon(h.iconName, 12)} ${v.label}
      </span>
    `;
  }

  private renderConnectCommands(cl: Cluster): TemplateResult {
    const c = clusters.state;
    const s = store.state;
    const provider =
      c.runtime?.runtime === "podman"
        ? "KIND_EXPERIMENTAL_PROVIDER=podman "
        : "";
    const commands = [
      {
        note: `Import ${cl.context} into your kubeconfig (adds or refreshes it and makes it current)`,
        cmd: `${provider}kind export kubeconfig --name ${cl.name}`,
      },
      ...(cl.inKubeconfig
        ? [
            {
              note: "Already imported: switch kubectl to it",
              cmd: `kubectl config use-context ${cl.context}`,
            },
          ]
        : []),
      ...(cl.ax && s.axConfig
        ? [
            {
              note: "Point ax at this cluster",
              cmd: `ax config use-context ${cl.context}`,
            },
          ]
        : []),
    ];

    return html`
      <div class="connect">
        ${commands.map(
          (x) => html`
            <div class="connect-item">
              <div class="connect-note">${x.note}</div>
              <div class="row connect-cmd">
                <code class="selectable"><bdi dir="ltr">${x.cmd}</bdi></code>
                <button
                  class="btn small icon ghost"
                  title="Copy"
                  aria-label="Copy command"
                  @click=${() => {
                    void navigator.clipboard.writeText(x.cmd);
                    this.copiedCmd = x.cmd;
                    setTimeout(() => {
                      if (this.copiedCmd === x.cmd) this.copiedCmd = "";
                    }, 1200);
                  }}
                >
                  ${icon(this.copiedCmd === x.cmd ? "check" : "copy", 12, {
                    color:
                      this.copiedCmd === x.cmd ? "var(--green)" : undefined,
                  })}
                </button>
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderAteLocalCard(): TemplateResult {
    const c = clusters.state;
    const al = c.ateLocal;
    const s = store.state;
    const busy = c.op?.status === "running";
    const mine = busy && c.op?.cluster === "ate-local";
    const current = s.context === "local";
    const isSel = this.selected === "ate-local";

    const axHealth: Health = al.axServer
      ? "ok"
      : al.ateLocal || al.postgres
        ? "warn"
        : "none";
    const subHealth: Health = al.ateLocal
      ? "ok"
      : al.postgres
        ? "warn"
        : "none";
    const pgHealth: Health = !al.available
      ? "none"
      : al.postgres
        ? "ok"
        : "none";

    const rows: {
      id: string;
      iconName: IconName;
      title: string;
      detail: string;
      health: Health;
    }[] = [
      {
        id: "ax",
        iconName: "server",
        title: "AX Control Plane",
        health: axHealth,
        detail: al.axServer
          ? `ax-server listening on ${s.settings.localServer}`
          : "Stopped (port 8090)",
      },
      {
        id: "substrate",
        iconName: "layers",
        title: "ate-local Substrate",
        health: subHealth,
        detail: al.ateLocal
          ? `ControlServer :50051 · ${al.actors.length} microVM${al.actors.length === 1 ? "" : "s"} on vmnet`
          : "Stopped (port 50051)",
      },
      {
        id: "container",
        iconName: "laptop",
        title: "Apple Container & PostgreSQL",
        health: pgHealth,
        detail: !al.available
          ? "Apple container CLI (/usr/local/bin/container) not found"
          : al.postgres
            ? "postgres:17-alpine running (:5432) · Apple container ready"
            : "Apple container ready · PostgreSQL stopped",
      },
    ];

    const anyUp = al.axServer || al.ateLocal || al.postgres;
    const allUp = al.axServer && al.ateLocal && al.postgres;
    const canRunScript =
      al.available && al.scriptFound && c.tools.go && c.tools.bash;
    const commands = [
      {
        note: "Point your shell ax CLI at the local Apple container stack",
        cmd: `cd ${s.settings.repoPath} && source .ax-local/env`,
      },
      {
        note: "Inspect local stack & active ate-* microVMs on vmnet (192.168.64.x)",
        cmd: `${s.settings.repoPath}/examples/ate_local/local-stack.sh status`,
      },
      {
        note: "Run multi-agent swarm recipe 01 from ax-experiments",
        cmd: `cd ${s.settings.experimentsPath} && make swarm-01`,
      },
    ];

    return html`
      <div
        class="card cluster-card ${mine ? "busy" : ""} ${
          current || isSel ? "highlight" : ""
        }"
      >
        <div class="row cluster-head">
          <div class="cluster-icon">${icon("laptop", 16)}</div>
          <div class="cluster-name">
            <div class="cluster-title">Apple Container (ate-local)</div>
            <div class="faint mono cluster-ctx">
              <bdi dir="ltr">local · ${s.settings.localServer}</bdi>${
                current ? " · in use" : ""
              }
            </div>
          </div>
          <div class="spacer"></div>
          ${this.renderOverall(rows)}
          <button
            class="btn term-btn ${isSel ? "active" : ""}"
            title=${
              isSel
                ? "Hide terminal commands"
                : "Use ate-local & ax-experiments from a terminal"
            }
            @click=${() => (this.selected = isSel ? null : "ate-local")}
          >
            ${icon("square-terminal", 14)} Terminal
          </button>
        </div>

        <div class="layer-stack">
          ${rows.map((r) => {
            const h = HEALTH[r.health];
            return html`
              <div class="layer ${r.health}" style="--c:${h.color}">
                ${icon(r.iconName, 14, { className: "layer-icon" })}
                <div class="layer-text">
                  <div class="layer-title">${r.title}</div>
                  <div class="layer-detail">${r.detail}</div>
                </div>
                ${icon(h.iconName, 14, { color: h.color })}
              </div>
            `;
          })}
        </div>

        ${
          isSel
            ? html`
                <div class="connect">
                  ${commands.map(
                    (x) => html`
                      <div class="connect-item">
                        <div class="connect-note">${x.note}</div>
                        <div class="row connect-cmd">
                          <code class="selectable"
                            ><bdi dir="ltr">${x.cmd}</bdi></code
                          >
                          <button
                            class="btn small icon ghost"
                            title="Copy"
                            aria-label="Copy command"
                            @click=${() => {
                              void navigator.clipboard.writeText(x.cmd);
                              this.copiedCmd = x.cmd;
                              setTimeout(() => {
                                if (this.copiedCmd === x.cmd)
                                  this.copiedCmd = "";
                              }, 1200);
                            }}
                          >
                            ${icon(
                              this.copiedCmd === x.cmd ? "check" : "copy",
                              12,
                              {
                                color:
                                  this.copiedCmd === x.cmd
                                    ? "var(--green)"
                                    : undefined,
                              },
                            )}
                          </button>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing
        }

        <div class="row cluster-actions">
          ${
            allUp
              ? html`
                  <button
                    class="btn small primary"
                    ?disabled=${busy}
                    title="Switch AX Central to the local Apple container stack"
                    @click=${() => void clusters.openLocalStack()}
                  >
                    ${icon("external-link", 12)}
                    ${current ? "Open Activity" : "Open in Central"}
                  </button>
                `
              : nothing
          }
          <button
            class="btn small ${!allUp ? "primary" : ""}"
            ?disabled=${busy || !canRunScript}
            title=${
              !al.scriptFound
                ? `examples/ate_local/local-stack.sh not found in ${s.settings.repoPath} (checkout ghchinoy/ax:feat/ate-local-apple-container)`
                : "Start PostgreSQL 17, ate-local (:50051), and ax-server (:8090)"
            }
            @click=${() => void clusters.localStackUp()}
          >
            ${icon(anyUp ? "refresh" : "play", 12)}
            ${anyUp ? "Restart Stack" : "Start Stack"}
          </button>
          ${
            anyUp
              ? html`
                  <button
                    class="btn small"
                    ?disabled=${busy || !canRunScript}
                    title="Reset stack and remove actor containers"
                    @click=${() => void clusters.localStackReset()}
                  >
                    ${icon("rotate-ccw", 12)} Reset
                  </button>
                  <div class="spacer"></div>
                  <button
                    class="btn small ghost danger"
                    ?disabled=${busy || !canRunScript}
                    title="Stop ax-server, ate-local, and PostgreSQL"
                    @click=${() => void clusters.localStackDown()}
                  >
                    ${icon("square", 12)} Stop
                  </button>
                `
              : nothing
          }
        </div>
        ${mine ? html`<div class="step-progress"></div>` : nothing}
      </div>
    `;
  }

  private renderClusterCard(cl: Cluster): TemplateResult {
    const c = clusters.state;
    const s = store.state;
    const busy = c.op?.status === "running";
    const mine = busy && c.op?.cluster === cl.name;
    const rows = layersFor(cl);
    const axReady = rows[0].health === "ok";
    const current = s.context === cl.context;
    const isSel = this.selected === cl.name;
    const buildBlocked = clusters.buildProblems.length > 0;

    const install = () => {
      const reinstall = !!cl.ax;
      const msg = reinstall
        ? `Reinstall AX on ${cl.name}?\n\nThis rebuilds AX and recreates its Postgres, so existing tasks and workspaces are deleted. Substrate is reinstalled if its version differs from the one AX is built against.`
        : `Install AX on ${cl.name}?\n\nThis installs Agent Substrate${cl.substrate ? " (reinstalling it if its version differs from the one AX is built against)" : ""}, a gVisor worker pool and the AX control plane.`;
      if (confirm(msg)) void clusters.install(cl.name);
    };

    const remove = () => {
      if (
        confirm(
          `Delete kind cluster ${cl.name}?\n\nThe cluster and everything in it are removed, and kind-${cl.name} is dropped from your kubeconfig.`,
        )
      ) {
        void clusters.remove(cl.name);
      }
    };

    return html`
      <div
        class="card cluster-card ${mine ? "busy" : ""} ${
          current || isSel ? "highlight" : ""
        }"
      >
        <div class="row cluster-head">
          <div class="cluster-icon">${icon("boxes", 16)}</div>
          <div class="cluster-name">
            <div class="cluster-title"><bdi dir="ltr">${cl.name}</bdi></div>
            <div class="faint mono cluster-ctx">
              <bdi dir="ltr">${cl.context}</bdi>${current ? " · in use" : ""}
            </div>
          </div>
          <div class="spacer"></div>
          ${this.renderOverall(rows)}
          <button
            class="btn term-btn ${isSel ? "active" : ""}"
            title=${
              isSel
                ? "Hide terminal commands"
                : "Use this cluster from a terminal"
            }
            @click=${() => (this.selected = isSel ? null : cl.name)}
          >
            ${icon("square-terminal", 14)} Terminal
          </button>
        </div>

        <div class="layer-stack">
          ${rows.map((r) => {
            const h = HEALTH[r.health];
            return html`
              <div class="layer ${r.health}" style="--c:${h.color}">
                ${icon(r.iconName, 14, { className: "layer-icon" })}
                <div class="layer-text">
                  <div class="layer-title">${r.title}</div>
                  <div class="layer-detail">${r.detail}</div>
                </div>
                ${icon(h.iconName, 14, { color: h.color })}
              </div>
            `;
          })}
        </div>

        ${isSel ? this.renderConnectCommands(cl) : nothing}

        <div class="row cluster-actions">
          ${
            axReady
              ? html`
                  <button
                    class="btn small primary"
                    ?disabled=${busy}
                    title=${
                      cl.inKubeconfig
                        ? `Switch AX Central to ${cl.context}`
                        : `Add ${cl.context} to your kubeconfig and switch AX Central to it`
                    }
                    @click=${() => void clusters.open(cl)}
                  >
                    ${icon("external-link", 12)}
                    ${current ? "Open Activity" : "Open in Central"}
                  </button>
                `
              : nothing
          }
          ${
            cl.reachable
              ? html`
                  <button
                    class="btn small"
                    ?disabled=${busy || buildBlocked}
                    title=${
                      buildBlocked ? clusters.buildProblems.join(" ") : ""
                    }
                    @click=${install}
                  >
                    ${icon(cl.ax ? "wrench" : "play", 12)}
                    ${cl.ax ? "Reinstall AX" : "Install AX"}
                  </button>
                `
              : nothing
          }
          <div class="spacer"></div>
          <button
            class="btn small ghost danger"
            ?disabled=${busy}
            title="Delete ${cl.name}"
            @click=${remove}
          >
            ${icon("trash", 12)} Delete
          </button>
        </div>
        ${mine ? html`<div class="step-progress"></div>` : nothing}
      </div>
    `;
  }

  private renderDoctorCard(): TemplateResult {
    const c = clusters.state;
    const busy = c.op?.status === "running";
    const checks = c.doctor;
    if (!checks.length) return html``;
    const repairable = checks.filter((ch) => ch.installTarget);

    return html`
      <div class="card new-cluster" aria-label="Prerequisite Doctor">
        <div class="row new-cluster-head">
          ${icon("wrench", 15)}
          <span>Prerequisite Doctor</span>
          <span class="spacer"></span>
          ${
            repairable.length > 0
              ? html`
                  <button
                    class="btn small primary"
                    ?disabled=${busy}
                    title="Install/build all missing ate-local & ax-experiments prerequisites"
                    @click=${() => void clusters.bootstrap("all")}
                  >
                    ${icon("play", 11)} Bootstrap All
                  </button>
                `
              : html`<span class="badge" style="--c:var(--green)"
                  >${icon("circle-check", 12)} Ready</span
                >`
          }
        </div>
        <div class="layer-stack">
          ${checks.map((ch) => {
            const h =
              ch.status === "ok"
                ? HEALTH.ok
                : ch.status === "fail"
                  ? HEALTH.fail
                  : HEALTH.warn;
            return html`
              <div class="layer ${ch.status}" style="--c:${h.color}">
                ${icon(h.iconName, 14, { color: h.color })}
                <div class="layer-text">
                  <div class="layer-title">${ch.title}</div>
                  <div class="layer-detail" title=${ch.fix || ch.detail}>
                    ${ch.detail}
                  </div>
                </div>
                ${
                  ch.installTarget
                    ? html`
                        <button
                          class="btn small"
                          ?disabled=${busy}
                          title=${ch.fix}
                          @click=${() =>
                            void clusters.bootstrap(ch.installTarget!)}
                        >
                          Repair
                        </button>
                      `
                    : nothing
                }
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }

  private renderNewClusterForm(): TemplateResult {
    const c = clusters.state;
    const f = c.form;
    const busy = c.op?.status === "running";
    const nameProblem = clusters.nameProblem(f.name);
    const blockers = [...clusters.problems, ...clusters.buildProblems];
    const engine = c.runtime?.runtime;

    return html`
      <div class="card new-cluster">
        <div class="row new-cluster-head">
          ${icon("plus", 15)}
          <span>New cluster</span>
        </div>
        <label class="form-row">
          <span>Name</span>
          <input
            class="input mono ${f.name && nameProblem ? "invalid" : ""}"
            .value=${f.name}
            spellcheck="false"
            placeholder="ax-dev"
            @input=${(e: Event) =>
              clusters.setForm({
                name: (e.target as HTMLInputElement).value.trim().toLowerCase(),
              })}
          />
        </label>
        <label class="form-row">
          <span>Workers</span>
          <input
            class="input"
            type="number"
            min="1"
            max="8"
            .value=${String(f.workers)}
            @input=${(e: Event) =>
              clusters.setForm({
                workers: Math.max(
                  1,
                  Math.min(
                    8,
                    Number((e.target as HTMLInputElement).value) || 1,
                  ),
                ),
              })}
          />
        </label>
        <label class="form-row">
          <span>Substrate</span>
          <input
            class="input mono"
            .value=${f.substrateRef}
            spellcheck="false"
            placeholder="version in AX's go.mod"
            @input=${(e: Event) =>
              clusters.setForm({
                substrateRef: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
        <div class="caption new-cluster-note">
          Runs <span class="mono">hack/setup-e2e-kind.sh</span> from your AX
          repo with a local registry on
          localhost:5001${engine ? ` and ${engine}` : ""}. The cluster is added
          to your kubeconfig as
          <span class="mono">kind-${f.name || "name"}</span>; your current
          context stays as it is.
        </div>
        ${
          f.name && nameProblem
            ? html`<div class="row problem-line">
                ${icon("alert", 13)} ${nameProblem}
              </div>`
            : nothing
        }
        ${clusters.buildProblems.map(
          (p) => html`
            <div class="row problem-line">${icon("alert", 13)} ${p}</div>
          `,
        )}
        ${clusters.warnings.map(
          (p) => html`
            <div class="row problem-line selectable">
              ${icon("alert", 13)} ${p}
            </div>
          `,
        )}
        <button
          class="btn primary"
          ?disabled=${busy || !!nameProblem || blockers.length > 0}
          @click=${() => void clusters.create()}
        >
          ${icon("play", 13)} Create cluster
        </button>
      </div>
    `;
  }

  private renderOperationBar(op: Operation): TemplateResult {
    const secs = Math.round(((op.finished ?? Date.now()) - op.started) / 1000);
    const elapsed =
      secs >= 60
        ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`
        : `${secs}s`;
    const verb = {
      create: "Creating",
      install: "Installing AX on",
      delete: "Deleting",
      kubeconfig: "Adding to kubeconfig:",
      "local-up": "Starting",
      "local-down": "Stopping",
      "local-reset": "Resetting",
      bootstrap: "Bootstrapping",
    }[op.kind];
    const done = {
      create: "Created",
      install: "Installed AX on",
      delete: "Deleted",
      kubeconfig: "Added to kubeconfig:",
      "local-up": "Started",
      "local-down": "Stopped",
      "local-reset": "Reset",
      bootstrap: "Bootstrapped",
    }[op.kind];
    const title =
      op.status === "running"
        ? `${verb} ${op.cluster}`
        : op.status === "ok"
          ? `${done} ${op.cluster}`
          : `${verb} ${op.cluster} failed`;
    const currentIndex = STAGES.findIndex((s) => s.id === op.stage);
    const statusIcon: IconName =
      op.status === "running"
        ? "loader"
        : op.status === "ok"
          ? "circle-check"
          : "circle-x";
    const statusColor =
      op.status === "running"
        ? "var(--primary)"
        : op.status === "ok"
          ? "var(--green)"
          : "var(--danger)";

    return html`
      <div class="card op-bar">
        <div class="row op-head">
          ${icon(statusIcon, 15, {
            color: statusColor,
            className: op.status === "running" ? "spin" : "",
          })}
          <span class="op-title">${title}</span>
          <span class="faint num">
            ${elapsed}${
              op.status === "failed" && op.exit !== undefined
                ? ` · exit ${op.exit}`
                : ""
            }
          </span>
          <div class="spacer"></div>
          ${
            op.status !== "running"
              ? html`<button
                  class="btn small ghost"
                  @click=${() => clusters.set({ op: null })}
                >
                  Dismiss
                </button>`
              : nothing
          }
        </div>
        ${
          op.stage
            ? html`
                <div class="op-stages">
                  ${STAGES.map((s, i) => {
                    const st =
                      op.status === "ok" || i < currentIndex
                        ? "ok"
                        : i > currentIndex
                          ? "idle"
                          : op.status === "failed"
                            ? "failed"
                            : "running";
                    const stIcon: IconName =
                      st === "ok"
                        ? "circle-check"
                        : st === "failed"
                          ? "circle-x"
                          : st === "running"
                            ? "loader"
                            : "circle";
                    return html`
                      <div class="op-stage ${st}">
                        ${icon(stIcon, 13, {
                          className: st === "running" ? "spin" : "",
                        })}
                        <span>${s.title}</span>
                      </div>
                    `;
                  })}
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  private renderConsoleLine = (l: ConsoleLine): TemplateResult => {
    const cls = `console-line ${l.header ?? ""}`.trim();
    const text = l.text.replace(/\r/g, "") || " ";
    return html`<div class=${cls}>${text}</div>`;
  };

  override render() {
    const c = clusters.state;
    const running = c.op?.status === "running";
    const problems = clusters.problems;

    return html`
      <div class="clusters">
        <div class="clusters-top">
          <div class="page-header">
            <div>
              <h1>Clusters</h1>
              <p>
                Local AX clusters on kind: Kubernetes, then Agent Substrate,
                then the AX control plane.
              </p>
            </div>
            <div class="spacer"></div>
            ${
              running
                ? html`<button class="btn" @click=${() => clusters.cancel()}>
                    ${icon("square", 12)} Stop
                  </button>`
                : nothing
            }
            <button
              class="btn"
              ?disabled=${c.loading}
              title="Refresh"
              @click=${() => void clusters.refresh()}
            >
              ${icon("refresh", 13, { className: c.loading ? "spin" : "" })}
              Refresh
            </button>
          </div>

          ${problems.map(
            (p) => html`
              <div class="row problem-line">${icon("alert", 14)} ${p}</div>
            `,
          )}

          <div class="clusters-layout">
            <div class="cluster-grid">
              ${this.renderAteLocalCard()}
              ${c.clusters.map((cl) => this.renderClusterCard(cl))}
            </div>
            <div class="col" style="gap:14px">
              ${this.renderDoctorCard()} ${this.renderNewClusterForm()}
            </div>
          </div>

          ${c.op ? this.renderOperationBar(c.op) : nothing}
        </div>

        <div class="console ${this.outputOpen ? "" : "collapsed"}">
          <div
            class="row console-bar collapsible"
            title=${this.outputOpen ? "Collapse output" : "Expand output"}
            @click=${() => (this.outputOpen = !this.outputOpen)}
          >
            ${icon("terminal", 13)}
            <span>Output</span>
            <div class="spacer"></div>
            <span class="faint">${c.log.length} lines</span>
            <button
              class="btn small ghost"
              ?disabled=${running}
              @click=${(e: Event) => {
                e.stopPropagation();
                clusters.set({ log: [] });
              }}
            >
              Clear
            </button>
            ${icon(this.outputOpen ? "chevron-down" : "chevron-up", 14)}
          </div>
          ${
            this.outputOpen
              ? html`
                  <div
                    class="console-body selectable"
                    @scroll=${(e: Event) => {
                      const el = e.currentTarget as HTMLElement;
                      this.stickConsole =
                        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    }}
                  >
                    ${
                      c.log.length === 0
                        ? html`<div class="console-empty">
                            Create a cluster, or install AX on an existing one.
                          </div>`
                        : c.log.map(this.renderConsoleLine)
                    }
                  </div>
                `
              : nothing
          }
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
      .clusters {
        height: 100%;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .clusters-top {
        padding: 24px 28px 16px;
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      .clusters-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 300px;
        gap: 16px;
        align-items: start;
        margin-top: 4px;
      }
      .cluster-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
        gap: 14px;
      }
      .cluster-empty {
        padding: 28px 16px;
      }
      .cluster-card {
        position: relative;
        overflow: hidden;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .cluster-card.busy {
        border-color: color-mix(in srgb, var(--primary) 55%, transparent);
      }
      .cluster-head {
        gap: 10px;
      }
      .cluster-icon {
        width: 32px;
        height: 32px;
        border-radius: var(--radius-s);
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--primary);
        background: var(--accent-soft);
      }
      .cluster-name {
        min-width: 0;
      }
      .cluster-title {
        font-weight: 600;
        font-size: 14px;
      }
      .cluster-ctx {
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .layer-stack {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .layer {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 10px;
        border-radius: var(--radius-s);
        background: color-mix(in srgb, var(--c) 8%, var(--surface-container));
        border-left: 3px solid var(--c);
      }
      .layer.none {
        background: var(--surface-container);
        border-left-style: dashed;
      }
      .layer-icon {
        color: var(--on-surface-variant);
        flex: none;
      }
      .layer-text {
        flex: 1;
        min-width: 0;
      }
      .layer-title {
        font-size: 12.5px;
        font-weight: 600;
      }
      .layer-detail {
        font-size: 11.5px;
        color: var(--on-surface-variant);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .layer.none .layer-title,
      .layer.none .layer-detail {
        color: var(--text-3);
      }
      .cluster-actions {
        gap: 6px;
      }
      .new-cluster {
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        position: sticky;
        top: 0;
      }
      .new-cluster-head {
        gap: 7px;
        font-weight: 600;
        color: var(--on-surface);
      }
      .new-cluster-head svg {
        color: var(--primary);
      }
      .form-row {
        display: grid;
        grid-template-columns: 74px 1fr;
        align-items: center;
        gap: 8px;
        color: var(--on-surface-variant);
      }
      .form-row .input {
        width: 100%;
        min-width: 0;
      }
      .new-cluster-note {
        line-height: 1.45;
      }
      .problem-line {
        color: var(--warn);
        margin-top: 6px;
        gap: 6px;
      }
      .new-cluster .problem-line {
        margin-top: 0;
        font-size: 12px;
        align-items: flex-start;
      }
      .op-bar {
        margin-top: 16px;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .op-head {
        gap: 8px;
      }
      .op-title {
        font-weight: 600;
      }
      .op-stages {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
      }
      .op-stage {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 9px;
        border-radius: var(--radius-s);
        font-size: 12px;
        background: var(--surface-container);
        color: var(--text-3);
        border-bottom: 2px solid transparent;
      }
      .op-stage.ok {
        color: var(--on-surface);
        border-bottom-color: var(--green);
      }
      .op-stage.ok svg {
        color: var(--green);
      }
      .op-stage.running {
        color: var(--on-surface);
        border-bottom-color: var(--primary);
      }
      .op-stage.running svg {
        color: var(--primary);
      }
      .op-stage.failed {
        color: var(--on-surface);
        border-bottom-color: var(--danger);
      }
      .op-stage.failed svg {
        color: var(--danger);
      }
      .term-btn.btn {
        background: var(--console);
        color: #fff;
        border-color: transparent;
      }
      .term-btn.btn:hover:not(:disabled) {
        background: var(--console);
        filter: brightness(1.35);
      }
      .term-btn.btn.active {
        box-shadow:
          0 0 0 2px var(--surface-bright),
          0 0 0 4px var(--primary);
      }
      .connect {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-top: 2px;
      }
      .connect-note {
        font-size: 11.5px;
        color: var(--on-surface-variant);
        margin-bottom: 3px;
      }
      .connect-cmd {
        gap: 4px;
        padding: 4px 4px 4px 10px;
        border-radius: var(--radius-s);
        background: var(--console);
        color: var(--console-text);
        align-items: flex-start;
      }
      .connect-cmd code {
        flex: 1;
        min-width: 0;
        padding: 4px 0;
        font-family: var(--font-mono);
        font-size: 11.5px;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .connect-cmd .btn.ghost {
        color: #b4b4ba;
      }
      .step-progress {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 2px;
        background: linear-gradient(
          90deg,
          transparent,
          var(--primary),
          transparent
        );
        background-size: 50% 100%;
        background-repeat: no-repeat;
        animation: sweep 1.2s linear infinite;
      }
      @keyframes sweep {
        from {
          background-position: -50% 0;
        }
        to {
          background-position: 150% 0;
        }
      }
    `,
  ];
}
