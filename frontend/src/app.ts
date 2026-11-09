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

import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import logo from "./assets/axel.svg";
import { ensureStudioBridge } from "./bridge";
import { type IconName, icon, renderPulseDot, renderSpinner } from "./icons";
import { clusters } from "./model/clusters";
import { designer } from "./model/designer";
import { type AXContext, shortName } from "./model/resources";
import { type Section, store } from "./model/store";
import { ToolCallEvent, ToolHost } from "./registry";
import { sharedStyles } from "./shared-styles";
import "./theme.css";
import { TOOL_GROUPS, TOOLS } from "./tools";
import "./views/clusters-view";
import "./views/designer-view";
import "./views/overview-view";
import "./views/terminal-view";
import "./views/topology-view";
import "./views/webmcp-drawer";
import type { ToolLogEntry } from "./views/webmcp-drawer";

/**
 * Technical LTR token pattern (Luminous 0.19 BiDi prose isolation):
 * URLs, CLI flags, snake_case tool/task identifiers, and dotted paths.
 */
const TECH_TOKEN_RE =
  /(https?:\/\/\S+|(?:^|(?<=\s))--?[a-zA-Z0-9][\w-]*|\b[a-zA-Z_][a-zA-Z0-9_]*(?:[._/][a-zA-Z0-9_]+)+\b|\b(?:task|ws|ax)_?[a-zA-Z0-9-]+\b)/g;

export function renderProseWithBdi(
  text: string,
): (string | TemplateResult)[] | string {
  TECH_TOKEN_RE.lastIndex = 0;
  if (!TECH_TOKEN_RE.test(text)) return text;
  TECH_TOKEN_RE.lastIndex = 0;
  const parts: (string | TemplateResult)[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TECH_TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(html`<bdi dir="ltr">${m[0]}</bdi>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const NO_DRAG_SELECTOR =
  'button, input, select, textarea, a, [role="button"], .no-drag, .dropdown, .menu';

/**
 * Determines whether a mousedown/dblclick event inside <ax-central> Shadow DOM
 * originated on a draggable titlebar region (.titlebar-drag) outside interactive controls.
 */
export function isTitlebarDragTarget(e: MouseEvent): boolean {
  for (const node of e.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.matches(NO_DRAG_SELECTOR)) return false;
    if (node.classList.contains("titlebar-drag")) return true;
  }
  return false;
}

const SECTIONS: {
  id: Section;
  title: string;
  iconName: IconName;
  group: "Overview" | "Build";
}[] = [
  { id: "overview", title: "Activity", iconName: "gauge", group: "Overview" },
  { id: "topology", title: "Map", iconName: "network", group: "Overview" },
  { id: "designer", title: "Deploy", iconName: "square-pen", group: "Build" },
  {
    id: "terminal",
    title: "Terminal",
    iconName: "square-terminal",
    group: "Build",
  },
  { id: "clusters", title: "Clusters", iconName: "boxes", group: "Build" },
];

const WEBMCP_GROUPS_KEY = "ax-central.webmcp.disabledGroups";

function loadDisabledGroups(): string[] {
  try {
    return JSON.parse(
      localStorage.getItem(WEBMCP_GROUPS_KEY) ?? "[]",
    ) as string[];
  } catch {
    return [];
  }
}

@customElement("ax-central")
export class AxCentral extends LitElement {
  @state() private contextMenuOpen = false;
  @state() private atespaceDraft = store.state.atespace;
  @state() private runningTools: string[] = [];
  @state() private toolLog: ToolLogEntry[] = [];
  @state() private disabledGroups: string[] = loadDisabledGroups();

  // Settings modal draft state
  @state() private setAxPath = store.state.settings.axPath;
  @state() private setRepoPath = store.state.settings.repoPath;
  @state() private setExpPath = store.state.settings.experimentsPath;
  @state() private setLocalServer = store.state.settings.localServer;
  @state() private setIntervalVal = store.state.settings.refreshInterval;
  @state() private newRegTitle = "";
  @state() private newRegPrefix = "";
  @state() private newRegImages = "";
  @state() private resolvedAxPath: string | null | undefined = undefined;

  readonly host = new ToolHost((signal) => ({
    store,
    designer,
    clusters,
    signal,
  }));

  private offStore: (() => void) | null = null;
  private offMenu: (() => void) | null = null;
  private whichTimer: ReturnType<typeof setTimeout> | null = null;
  ready: Promise<void> = Promise.resolve();

  override connectedCallback(): void {
    super.connectedCallback();
    ensureStudioBridge();
    this.offStore = store.subscribe(() => {
      if (this.atespaceDraft !== store.state.atespace) {
        this.atespaceDraft = store.state.atespace;
      }
      this.requestUpdate();
    });
    this.host.addEventListener("running", () => {
      this.runningTools = [...this.host.running];
    });
    this.host.addEventListener("change", () => this.requestUpdate());
    this.host.addEventListener("call", (ev) => {
      const e = ev as ToolCallEvent;
      const now = Date.now();
      this.toolLog = [
        ...this.toolLog,
        {
          at: now,
          kind: "call" as const,
          name: e.name,
          caller: e.caller,
          text: JSON.stringify(e.args),
        },
        {
          at: now,
          kind: (e.result.error ? "error" : "result") as "error" | "result",
          name: e.name,
          caller: e.caller,
          text: e.result.error ? String(e.result.error) : `ok (${e.ms} ms)`,
        },
      ].slice(-200);
    });
    this.addEventListener("mousedown", this.onHostMouseDown, true);
    this.addEventListener("dblclick", this.onHostDblClick);
    window.addEventListener("mousedown", this.onWindowDown);
    window.addEventListener("mouseup", this.clearDragStyle);
    window.addEventListener("blur", this.clearDragStyle);
    window.addEventListener("keydown", this.onKey);
    this.offMenu = window.studio.onMenu((action) => this.handleMenu(action));
    this.ready = this.init();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offStore?.();
    this.offMenu?.();
    if (this.whichTimer) clearTimeout(this.whichTimer);
    this.removeEventListener("mousedown", this.onHostMouseDown, true);
    this.removeEventListener("dblclick", this.onHostDblClick);
    window.removeEventListener("mousedown", this.onWindowDown);
    window.removeEventListener("mouseup", this.clearDragStyle);
    window.removeEventListener("blur", this.clearDragStyle);
    window.removeEventListener("keydown", this.onKey);
    store.stop();
  }

  /**
   * Wails v2 inspects getComputedStyle(e.target).getPropertyValue('--wails-draggable')
   * on window mousedown. Because Shadow DOM retargets e.target to <ax-central>,
   * reflect the inner target's drag state onto the host element before the event
   * reaches window bubble listeners.
   */
  private onHostMouseDown = (e: MouseEvent): void => {
    this.style.setProperty(
      "--wails-draggable",
      isTitlebarDragTarget(e) ? "drag" : "no-drag",
    );
  };

  private clearDragStyle = (): void => {
    this.style.removeProperty("--wails-draggable");
  };

  private onHostDblClick = (e: MouseEvent): void => {
    if (isTitlebarDragTarget(e)) {
      window.runtime?.WindowToggleMaximise?.();
    }
  };

  private async init(): Promise<void> {
    const off = new Set(
      this.disabledGroups.flatMap((g) => TOOL_GROUPS[g] ?? []),
    );
    await this.host.register(TOOLS.filter((t) => !off.has(t.name)));
    await store.start();
  }

  private async toggleGroup(group: string, on: boolean): Promise<void> {
    const names = TOOL_GROUPS[group] ?? [];
    if (on) {
      await this.host.register(TOOLS.filter((t) => names.includes(t.name)));
    } else {
      this.host.unregister(names);
    }
    const disabled = new Set(this.disabledGroups);
    if (on) disabled.delete(group);
    else disabled.add(group);
    this.disabledGroups = [...disabled];
    localStorage.setItem(
      WEBMCP_GROUPS_KEY,
      JSON.stringify(this.disabledGroups),
    );
  }

  private handleMenu(action: string): void {
    if (action.startsWith("section:")) {
      store.setSection(action.slice(8) as Section);
    } else if (action === "refresh") {
      void store.refresh();
    } else if (action === "settings") {
      this.openSettings();
    } else if (action === "webmcp") {
      store.set({ webmcpOpen: !store.state.webmcpOpen });
    } else if (action === "new-design") {
      designer.load("blank");
      store.setSection("designer");
    } else if (action === "open-manifest") {
      void designer.open(store.state.settings.repoPath);
      store.setSection("designer");
    } else if (action === "save-manifest") {
      void designer.save();
    } else if (action === "apply") {
      window.dispatchEvent(new Event("ax:apply"));
    }
  }

  private onWindowDown = (e: MouseEvent): void => {
    if (!this.contextMenuOpen) return;
    const path = e.composedPath();
    const dd = this.renderRoot.querySelector(".toolbar .dropdown");
    if (dd && !path.includes(dd)) {
      this.contextMenuOpen = false;
    }
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.contextMenuOpen) {
      this.contextMenuOpen = false;
    }
  };

  private openSettings(): void {
    this.setAxPath = store.state.settings.axPath;
    this.setRepoPath = store.state.settings.repoPath;
    this.setExpPath = store.state.settings.experimentsPath;
    this.setLocalServer = store.state.settings.localServer;
    this.setIntervalVal = store.state.settings.refreshInterval;
    this.resolveAxBinary(this.setAxPath);
    store.set({ settingsOpen: true });
  }

  private resolveAxBinary(axPath: string): void {
    this.resolvedAxPath = undefined;
    if (this.whichTimer) clearTimeout(this.whichTimer);
    this.whichTimer = setTimeout(() => {
      void window.studio.which(axPath).then((res) => {
        this.resolvedAxPath = res;
      });
    }, 150);
  }

  private saveSettings(): void {
    const axChanged =
      this.setAxPath !== store.state.settings.axPath ||
      this.setLocalServer !== store.state.settings.localServer;
    store.updateSettings({
      axPath: this.setAxPath,
      repoPath: this.setRepoPath,
      experimentsPath: this.setExpPath,
      localServer: this.setLocalServer,
      refreshInterval: this.setIntervalVal,
    });
    store.set({ settingsOpen: false });
    if (axChanged) {
      void store.loadContexts().then(() => store.refresh());
    }
  }

  private renderConnectionBadge() {
    const s = store.state;
    const color = s.connectionError
      ? "var(--danger)"
      : s.lastRefresh
        ? "var(--green)"
        : "var(--orange)";
    const status =
      s.connectionError ??
      (s.lastRefresh
        ? `updated ${new Date(s.lastRefresh).toLocaleTimeString()}`
        : "connecting…");
    return html`
      <div
        class="conn"
        title=${s.connectionError ?? s.axVersion ?? "Connected"}
      >
        ${renderPulseDot(color, !s.connectionError && !!s.lastRefresh)}
        <div class="col" style="min-width:0">
          <strong class="ellipsis"
            >${s.context ? shortName(s.context) : "connecting…"}</strong
          >
          <span class="caption muted clamp2">${status}</span>
        </div>
      </div>
    `;
  }

  private renderToolbar() {
    const s = store.state;
    const current = store.currentContext;
    const ctxIcon = (c?: AXContext): IconName =>
      c?.name === "local" ? "laptop" : "server";

    return html`
      <header class="toolbar titlebar-drag">
        <div class="toolbar-title">
          <img src=${logo} alt="" class="toolbar-logo" />
          <span>AX Central</span>
        </div>

        <div class="spacer"></div>

        <div class="no-drag row">
          <div class="dropdown">
            <button
              class="btn"
              title="Where ax sends commands. Switching here does not change your global ax config."
              @click=${() => (this.contextMenuOpen = !this.contextMenuOpen)}
            >
              ${icon(ctxIcon(current), 14)}
              <bdi dir="ltr"
                >${current ? shortName(current.name) : "Context"}</bdi
              >
              ${icon("chevron-down", 12, { className: "faint" })}
            </button>
            ${
              this.contextMenuOpen
                ? html`
                    <div class="menu card fade-in">
                      ${s.contexts.map(
                        (c) => html`
                          <button
                            class="menu-item"
                            @click=${() => {
                              store.setScope({ context: c.name });
                              this.contextMenuOpen = false;
                            }}
                          >
                            <span class="menu-check">
                              ${c.name === s.context ? icon("check", 13) : nothing}
                            </span>
                            ${icon(ctxIcon(c), 13)}
                            <span class="col">
                              <span>
                                <bdi dir="ltr">${shortName(c.name)}</bdi>${
                                  c.isCurrent
                                    ? html`<span class="faint">
                                        · default</span
                                      >`
                                    : nothing
                                }
                              </span>
                              ${
                                c.description
                                  ? html`<span class="caption faint"
                                      >${c.description}</span
                                    >`
                                  : nothing
                              }
                            </span>
                          </button>
                        `,
                      )}
                      ${
                        s.axConfig
                          ? html`
                              <div class="menu-sep"></div>
                              <button
                                class="menu-item"
                                ?disabled=${current?.isCurrent ?? true}
                                @click=${() => {
                                  void store.makeDefault(s.context);
                                  this.contextMenuOpen = false;
                                }}
                              >
                                <span class="menu-check"></span>
                                Make Default for ax CLI
                              </button>
                            `
                          : nothing
                      }
                    </div>
                  `
                : nothing
            }
          </div>

          <input
            class="input"
            style="width:110px"
            .value=${this.atespaceDraft}
            title="Atespace scope"
            aria-label="Atespace scope"
            placeholder="atespace"
            @input=${(e: Event) =>
              (this.atespaceDraft = (e.target as HTMLInputElement).value)}
            @blur=${() => {
              if (this.atespaceDraft !== s.atespace) {
                store.setScope({ atespace: this.atespaceDraft || "default" });
              }
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />

          <button
            class="btn icon"
            title="Refresh (⌘R)"
            aria-label="Refresh"
            @click=${() => void store.refresh()}
          >
            ${icon("refresh", 14, {
              className: s.isRefreshing ? "spin" : "",
            })}
          </button>

          <button
            class="btn webmcp-btn ${s.webmcpOpen ? "active" : ""}"
            title="Toggle WebMCP Inspector (⌘I)"
            aria-pressed=${s.webmcpOpen ? "true" : "false"}
            @click=${() => store.set({ webmcpOpen: !s.webmcpOpen })}
          >
            ${
              this.runningTools.length > 0
                ? renderSpinner()
                : icon("w3c", 14, { color: "var(--primary)" })
            }
            <span>WebMCP</span>
          </button>

          <button
            class="btn icon"
            title="Settings (⌘,)"
            aria-label="Settings"
            @click=${() => this.openSettings()}
          >
            ${icon("settings", 14)}
          </button>
        </div>
      </header>
    `;
  }

  private renderSettingsModal() {
    const s = store.state;
    const close = () => store.set({ settingsOpen: false });
    return html`
      <div class="modal-backdrop" @mousedown=${close}>
        <div
          class="modal card fade-in"
          role="dialog"
          aria-label="Settings"
          @mousedown=${(e: Event) => e.stopPropagation()}
        >
          <h3>Settings</h3>
          <div class="form-grid">
            <label for="set-ax-path">ax binary</label>
            <div class="col" style="gap:4px">
              <input
                id="set-ax-path"
                class="input mono"
                .value=${this.setAxPath}
                @input=${(e: Event) => {
                  const val = (e.target as HTMLInputElement).value;
                  this.setAxPath = val;
                  this.resolveAxBinary(val);
                }}
              />
              <span class="caption faint mono">
                ${
                  this.resolvedAxPath === undefined
                    ? "…"
                    : (this.resolvedAxPath ?? "not found on PATH")
                }
              </span>
            </div>
            <label for="set-repo-path">AX repository</label>
            <input
              id="set-repo-path"
              class="input mono"
              .value=${this.setRepoPath}
              @input=${(e: Event) =>
                (this.setRepoPath = (e.target as HTMLInputElement).value)}
            />
            <label for="set-exp-path">AX Experiments</label>
            <input
              id="set-exp-path"
              class="input mono"
              .value=${this.setExpPath}
              @input=${(e: Event) =>
                (this.setExpPath = (e.target as HTMLInputElement).value)}
            />
            <label for="set-local-server">Local AX_SERVER</label>
            <input
              id="set-local-server"
              class="input mono"
              .value=${this.setLocalServer}
              @input=${(e: Event) =>
                (this.setLocalServer = (e.target as HTMLInputElement).value)}
            />
            <label for="set-refresh-interval">Refresh</label>
            <div class="row">
              <input
                id="set-refresh-interval"
                type="range"
                min="2"
                max="30"
                step="1"
                style="flex:1"
                .value=${String(this.setIntervalVal)}
                @input=${(e: Event) =>
                  (this.setIntervalVal = +(e.target as HTMLInputElement).value)}
              />
              <span class="mono" style="width:32px;text-align:right"
                >${this.setIntervalVal}s</span
              >
            </div>
          </div>

          <div
            style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)"
          >
            <div class="row" style="margin-bottom:8px">
              <strong style="font-size:12.5px"
                >Image Artifact Registries</strong
              >
              <span class="caption faint"
                >Used by the Deploy image catalog &amp; @sha256: resolver</span
              >
            </div>
            <div class="col" style="gap:6px;margin-bottom:10px">
              ${designer.registries.map(
                (reg) => html`
                  <div
                    class="row"
                    style="padding:6px 10px;border-radius:var(--radius-xs);background:var(--surface-container);font-size:12px"
                  >
                    <div class="col" style="gap:2px;min-width:0;flex:1">
                      <strong class="ellipsis">${reg.title}</strong>
                      <span class="caption faint mono ellipsis"
                        ><bdi dir="ltr">${reg.prefix}</bdi> ·
                        ${
                          reg.images.map((i) => i.name).join(", ") || "custom"
                        }</span
                      >
                    </div>
                    ${
                      reg.builtIn
                        ? html`<span class="caption faint">built-in</span>`
                        : html`<button
                            class="btn small ghost icon danger"
                            title="Remove registry"
                            aria-label="Remove registry ${reg.title}"
                            @click=${() => {
                              designer.removeRegistry(reg.id);
                              this.requestUpdate();
                            }}
                          >
                            ${icon("trash", 12)}
                          </button>`
                    }
                  </div>
                `,
              )}
            </div>
            <div class="row" style="gap:6px">
              <input
                class="input mono"
                style="flex:1.2"
                placeholder="us-central1-docker.pkg.dev/my-proj/ax"
                aria-label="New registry prefix"
                .value=${this.newRegPrefix}
                @input=${(e: Event) =>
                  (this.newRegPrefix = (e.target as HTMLInputElement).value)}
              />
              <input
                class="input"
                style="flex:1"
                placeholder="Title (optional)"
                aria-label="New registry title"
                .value=${this.newRegTitle}
                @input=${(e: Event) =>
                  (this.newRegTitle = (e.target as HTMLInputElement).value)}
              />
              <input
                class="input mono"
                style="flex:1"
                placeholder="img1,img2"
                aria-label="New registry image names"
                .value=${this.newRegImages}
                @input=${(e: Event) =>
                  (this.newRegImages = (e.target as HTMLInputElement).value)}
              />
              <button
                class="btn small"
                ?disabled=${!this.newRegPrefix.trim()}
                @click=${() => {
                  const prefix = this.newRegPrefix.trim().replace(/\/+$/, "");
                  if (!prefix) return;
                  const imgs = this.newRegImages
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((name) => ({ name }));
                  designer.saveRegistry({
                    id: prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase(),
                    title: this.newRegTitle.trim() || prefix,
                    prefix,
                    images: imgs,
                  });
                  this.newRegPrefix = "";
                  this.newRegTitle = "";
                  this.newRegImages = "";
                  this.requestUpdate();
                }}
              >
                ${icon("plus", 12)} Add
              </button>
            </div>
          </div>

          <div class="row" style="margin-top:18px;justify-content:flex-end">
            <button
              class="btn small ghost"
              style="margin-right:auto"
              title="Open Prerequisite Doctor in Clusters"
              @click=${() => {
                close();
                store.setSection("clusters");
              }}
            >
              ${icon("wrench", 12)} Prerequisite Doctor
            </button>
            <span class="caption faint">
              ${s.axVersion?.split("\n")[0] ?? ""}
            </span>
            <button class="btn" @click=${close}>Cancel</button>
            <button class="btn primary" @click=${() => this.saveSettings()}>
              Save
            </button>
          </div>
        </div>
      </div>
    `;
  }

  override render() {
    const s = store.state;
    return html`
      <div class="shell">
        <aside class="sidebar" aria-label="Primary navigation">
          <div class="titlebar-drag sidebar-top"></div>
          <nav aria-label="Sections">
            ${(["Overview", "Build"] as const).map(
              (g) => html`
                <div class="nav-group">
                  <div class="nav-heading">${g}</div>
                  ${SECTIONS.filter((x) => x.group === g).map(
                    (x) => html`
                      <button
                        class="nav-item ${s.section === x.id ? "on" : ""}"
                        aria-current=${s.section === x.id ? "page" : "false"}
                        @click=${() => store.setSection(x.id)}
                      >
                        ${icon(x.iconName, 15)}
                        <span>${x.title}</span>
                        ${
                          x.id === "overview" && s.tasks.length > 0
                            ? html`<span class="nav-count"
                                >${s.tasks.length}</span
                              >`
                            : nothing
                        }
                        ${
                          x.id === "terminal" && s.terminalTabs.length > 0
                            ? html`<span class="nav-count"
                                >${s.terminalTabs.length}</span
                              >`
                            : nothing
                        }
                      </button>
                    `,
                  )}
                </div>
              `,
            )}
          </nav>
          <div class="spacer"></div>
          ${this.renderConnectionBadge()}
        </aside>

        <div class="main">
          ${this.renderToolbar()}
          <div class="workspace-row">
            <main class="viewport">
              ${
                s.section !== "terminal"
                  ? html`
                      <div class="content">
                        ${
                          s.section === "overview"
                            ? html`<ax-overview></ax-overview>`
                            : nothing
                        }
                        ${
                          s.section === "topology"
                            ? html`<ax-topology></ax-topology>`
                            : nothing
                        }
                        ${
                          s.section === "designer"
                            ? html`<ax-designer></ax-designer>`
                            : nothing
                        }
                        ${
                          s.section === "clusters"
                            ? html`<ax-clusters></ax-clusters>`
                            : nothing
                        }
                      </div>
                    `
                  : nothing
              }
              ${
                s.section === "terminal" || s.terminalTabs.length > 0
                  ? html`
                      <div class="content" ?hidden=${s.section !== "terminal"}>
                        <ax-terminal></ax-terminal>
                      </div>
                    `
                  : nothing
              }
            </main>

            ${
              s.webmcpOpen
                ? html`
                    <ax-webmcp-drawer
                      .host=${this.host}
                      .log=${this.toolLog}
                      .disabledGroups=${this.disabledGroups}
                      @toggle-group=${(
                        e: CustomEvent<{ group: string; on: boolean }>,
                      ) => void this.toggleGroup(e.detail.group, e.detail.on)}
                      @close=${() => store.set({ webmcpOpen: false })}
                    ></ax-webmcp-drawer>
                  `
                : nothing
            }
          </div>
        </div>

        ${s.settingsOpen ? this.renderSettingsModal() : nothing}
      </div>
    `;
  }

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        height: 100vh;
        color: var(--on-surface);
        background: var(--surface);
      }
      .shell {
        display: flex;
        height: 100%;
      }
      .titlebar-drag {
        --wails-draggable: drag;
        -webkit-app-region: drag;
      }
      .no-drag,
      .titlebar-drag button,
      .titlebar-drag input {
        --wails-draggable: no-drag;
        -webkit-app-region: no-drag;
      }

      /* Sidebar */
      .sidebar {
        width: 216px;
        flex: none;
        display: flex;
        flex-direction: column;
        background: var(--surface-container-low);
        border-right: 1px solid var(--border);
        padding: 0 10px 10px;
      }
      .sidebar-top {
        height: var(--titlebar);
        flex: none;
      }
      .nav-group {
        margin-bottom: 14px;
      }
      .nav-heading {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-3);
        padding: 0 10px 5px;
      }
      .nav-item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 9px;
        height: 32px;
        padding: 0 10px;
        border: 0;
        border-radius: var(--radius-s);
        background: transparent;
        color: var(--on-surface);
        cursor: pointer;
        text-align: left;
        font-size: 13px;
      }
      .nav-item svg {
        color: var(--primary);
        flex: none;
      }
      .nav-item:hover {
        background: var(--surface-container);
      }
      .nav-item.on {
        background: var(--primary-container);
        color: var(--on-primary-container);
        font-weight: 600;
      }
      .nav-item span:first-of-type {
        flex: 1;
      }
      .nav-count {
        font-size: 11px;
        color: var(--on-surface-variant);
        font-variant-numeric: tabular-nums;
      }
      .conn {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: var(--radius-m);
        background: var(--surface-container);
        font-size: 12px;
      }

      /* Main */
      .main {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        background: var(--surface);
      }
      .toolbar {
        height: var(--titlebar);
        flex: none;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 14px 0 20px;
        border-bottom: 1px solid var(--border);
        background: var(--surface-bright);
        box-shadow: var(--shadow-1);
        z-index: 2;
      }
      .toolbar-title {
        font-family: var(--font-display);
        font-size: 15px;
        font-weight: 650;
        color: var(--on-surface);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .toolbar-logo {
        height: 22px;
        width: auto;
      }
      .webmcp-btn.active {
        background: var(--primary-container);
        color: var(--on-primary-container);
        border-color: var(--primary);
      }
      .workspace-row {
        flex: 1;
        min-height: 0;
        display: flex;
      }
      .viewport {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .content {
        flex: 1;
        min-height: 0;
        position: relative;
      }
      .form-grid {
        display: grid;
        grid-template-columns: 120px 1fr;
        gap: 12px 14px;
        align-items: center;
      }
      .form-grid > label {
        color: var(--on-surface-variant);
        text-align: right;
      }
    `,
  ];
}
