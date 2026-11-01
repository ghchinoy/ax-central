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

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css?inline";
import {
  css,
  html,
  LitElement,
  nothing,
  type PropertyValues,
  unsafeCSS,
} from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { ensureStudioBridge } from "../bridge";
import { icon, renderPhaseIcon } from "../icons";
import { comparePhase, phaseLabel } from "../model/resources";
import { type TerminalTab, store } from "../model/store";
import { sharedStyles } from "../shared-styles";

let sessions = 0;
const LINE_MODE = "AXS-LINE-MODE";

const REMOTE = `if command -v script >/dev/null 2>&1; then
  exec env TERM=xterm-256color script -qefc "stty rows $1 cols $2; if command -v bash >/dev/null 2>&1; then exec bash -i; else exec sh -i; fi" /dev/null
fi
echo ${LINE_MODE}
exec sh -i`;

const lineOutput = (s: string) =>
  s
    .replace(/^.*can't access tty; job control turned off\r?\n?/m, "")
    .replace(/\r?\n/g, "\r\n");

const shq = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

const externalCommand = (ssh: string) =>
  `stty raw -echo; ${ssh} -- sh -c 'command -v script >/dev/null || exec sh -i; exec env TERM=xterm-256color script -qefc "stty rows $0 cols $1; command -v bash >/dev/null && exec bash -i; exec sh -i" /dev/null' "$(tput lines)" "$(tput cols)"; stty sane`;

let firstCommand = new URLSearchParams(location.search).get("terminal");

export interface TerminalBackendOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export interface TerminalBackend {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  open(host: HTMLElement, opts: TerminalBackendOptions): void;
  write(data: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
  proposeDimensions(): { cols: number; rows: number } | null;
  hasSelection(): boolean;
  getSelection(): string;
  focus(): void;
  dispose(): void;
}

/**
 * Default TerminalBackend implementation using Ghostty's default dark palette
 * (#161616 / #f2f4f8 / #25be6a) and xterm-ghostty compatible VT emulation.
 */
export function createTerminalBackend(): TerminalBackend {
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  return {
    get name() {
      return "ghostty-vt";
    },
    get cols() {
      return term?.cols ?? 80;
    },
    get rows() {
      return term?.rows ?? 24;
    },
    open(host: HTMLElement, opts: TerminalBackendOptions) {
      term = new Terminal({
        fontFamily: opts.fontFamily,
        fontSize: opts.fontSize,
        lineHeight: opts.lineHeight,
        cursorBlink: true,
        scrollback: 10000,
        theme: {
          background: "#161616",
          foreground: "#f2f4f8",
          cursor: "#25be6a",
          selectionBackground: "#3a3f4b",
          black: "#282828",
          red: "#ee5396",
          green: "#25be6a",
          yellow: "#08bdba",
          blue: "#78a9ff",
          magenta: "#be95ff",
          cyan: "#33b1ff",
          white: "#dfdfe0",
          brightBlack: "#484848",
          brightRed: "#f16da6",
          brightGreen: "#46c880",
          brightYellow: "#2dc7c4",
          brightBlue: "#8cb6ff",
          brightMagenta: "#c8a5ff",
          brightCyan: "#52bdff",
          brightWhite: "#e4e4e5",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
    },
    write(data: string) {
      term?.write(data);
    },
    onData(cb: (data: string) => void) {
      return term ? term.onData(cb) : { dispose() {} };
    },
    proposeDimensions() {
      const dims = fit?.proposeDimensions();
      return dims ? { cols: dims.cols, rows: dims.rows } : null;
    },
    hasSelection() {
      return term?.hasSelection() ?? false;
    },
    getSelection() {
      return term?.getSelection() ?? "";
    },
    focus() {
      term?.focus();
    },
    dispose() {
      term?.dispose();
      term = null;
      fit = null;
    },
  };
}

function tabLabel(tab: TerminalTab, tabs: TerminalTab[]): string {
  const same = tabs.filter(
    (x) => x.task.id === tab.task.id && x.context === tab.context,
  );
  return same.length > 1
    ? `${tab.task.name} (${same.indexOf(tab) + 1})`
    : tab.task.name;
}

@customElement("ax-terminal-session")
export class AxTerminalSession extends LitElement {
  @property({ attribute: false }) tab!: TerminalTab;
  @property({ type: Boolean }) active = false;
  @state() private status: "connecting" | "connected" | "exited" = "connecting";
  @state() private mode: "pty" | "line" | null = null;
  @state() private size = "";
  @state() private resized = false;
  @state() private copied = false;
  @query(".term-host") private hostEl?: HTMLDivElement;

  private term: TerminalBackend | null = null;
  private cleanupSession: (() => void) | null = null;
  private offStore: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.offStore = store.subscribe(() => this.requestUpdate());
  }

  override firstUpdated(): void {
    this.startTerminal();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("active") && this.active) {
      this.term?.focus();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offStore?.();
    this.cleanupSession?.();
  }

  private copyCommand(): void {
    const argv = [
      store.effectiveAxPath,
      ...this.tab.scope,
      "ssh",
      this.tab.task.name,
    ];
    void navigator.clipboard.writeText(
      externalCommand(argv.map(shq).join(" ")),
    );
    this.copied = true;
    setTimeout(() => (this.copied = false), 1400);
  }

  private openInGhostty(): void {
    ensureStudioBridge();
    void window.studio.run({
      program: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
      args: [
        "-e",
        store.effectiveAxPath,
        ...this.tab.scope,
        "ssh",
        this.tab.task.name,
      ],
    });
  }

  private startTerminal(): void {
    this.cleanupSession?.();
    this.cleanupSession = null;
    const el = this.hostEl;
    if (!el || !this.tab) return;

    ensureStudioBridge();
    const term = createTerminalBackend();
    term.open(el, {
      fontFamily:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.15,
    });
    this.term = term;
    if (this.active) term.focus();

    const { cols, rows } = term;
    this.size = `${cols}×${rows}`;
    this.resized = false;
    this.status = "connecting";
    this.mode = null;

    const sid = `terminal-${++sessions}`;
    let decided: "pty" | "line" | null = null;
    let pending = "";
    let line = "";

    const decide = (m: "pty" | "line") => {
      decided = m;
      this.mode = m;
      if (firstCommand) {
        if (m === "pty")
          void window.studio.writeSession(sid, firstCommand + "\r");
        else {
          term.write(firstCommand + "\r\n");
          void window.studio.writeSession(sid, firstCommand + "\n");
        }
        firstCommand = null;
      }
    };

    const offData = window.studio.onSessionData((d) => {
      if (d.id !== sid) return;
      if (this.status === "connecting") this.status = "connected";
      if (d.stream === "stderr" || decided === "line") {
        term.write(lineOutput(d.data));
        return;
      }
      if (decided === "pty") {
        term.write(d.data);
        return;
      }
      pending += d.data;
      if (pending.startsWith(LINE_MODE)) {
        const nl = pending.indexOf("\n");
        if (nl < 0) return;
        decide("line");
        term.write(lineOutput(pending.slice(nl + 1)));
      } else if (!LINE_MODE.startsWith(pending)) {
        decide("pty");
        term.write(pending);
      }
    });

    const offExit = window.studio.onSessionExit((e) => {
      if (e.id !== sid) return;
      this.status = "exited";
      term.write(
        `\r\n\x1b[2m[session ended${e.status ? `, exit ${e.status}` : ""}]\x1b[0m\r\n`,
      );
    });

    const input = term.onData((data) => {
      if (decided !== "line") {
        void window.studio.writeSession(sid, data);
        return;
      }
      if (data.startsWith("\x1b")) return;
      for (const c of data) {
        if (c === "\r") {
          term.write("\r\n");
          void window.studio.writeSession(sid, line + "\n");
          line = "";
        } else if (c === "\x7f") {
          if (line) {
            line = line.slice(0, -1);
            term.write("\b \b");
          }
        } else if (c === "\x03") {
          term.write("^C\r\n");
          line = "";
          void window.studio.interruptSession(sid);
        } else if (c === "\x04") {
          if (!line) void window.studio.endSessionInput(sid);
        } else if (c >= " ") {
          line += c;
          term.write(c);
        }
      }
    });

    const observer = new ResizeObserver(() => {
      if (el.clientWidth === 0) return;
      const next = term.proposeDimensions();
      this.resized = !!next && (next.cols !== cols || next.rows !== rows);
    });
    observer.observe(el);

    void window.studio.startSession({
      id: sid,
      program: store.effectiveAxPath,
      args: [
        ...this.tab.scope,
        "ssh",
        this.tab.task.name,
        "--",
        "sh",
        "-c",
        REMOTE,
        "sh",
        String(rows),
        String(cols),
      ],
    });

    this.cleanupSession = () => {
      offData();
      offExit();
      input.dispose();
      observer.disconnect();
      void window.studio.closeSession(sid);
      this.term = null;
      term.dispose();
    };
  }

  override render() {
    if (!this.tab) return nothing;
    const s = store.state;
    const t = this.tab.task;
    const dotColor =
      this.status === "connected"
        ? "var(--green)"
        : this.status === "exited"
          ? "var(--text-3)"
          : "var(--orange)";

    return html`
      <div class="term-pane" ?hidden=${!this.active}>
        <div class="row term-title">
          <span
            class="pulse ${this.status === "connected" ? "on" : ""}"
            style="--c:${dotColor}"
          ></span>
          <strong><bdi dir="ltr">${t.name}</bdi></strong>
          <span class="spacer"></span>
          <button
            class="btn small ghost"
            title="Open another terminal to this task"
            @click=${() => store.duplicateTerminal(this.tab)}
          >
            ${icon("plus", 12)} New session
          </button>
          <button
            class="btn small ghost"
            title="Open session in external Ghostty.app window"
            @click=${() => this.openInGhostty()}
          >
            ${icon("external-link", 12)} Open in Ghostty
          </button>
          <button
            class="btn small ghost"
            title="Copy an ax ssh command for your terminal app"
            @click=${() => this.copyCommand()}
          >
            ${icon(this.copied ? "check" : "copy", 12)}
            ${this.copied ? "Copied" : "Copy ax ssh"}
          </button>
        </div>
        ${
          this.tab.context === s.context && s.details[t.id]?.debug === false
            ? html`
                <div class="term-banner caption">
                  Debug is off for this task, so ax ssh may not connect. Turn on
                  Debug in Deploy and create it again.
                </div>
              `
            : nothing
        }
        <div class="term-body">
          <div class="term-host"></div>
        </div>
        <div class="row term-foot caption faint">
          <span>
            ${
              this.status === "connecting"
                ? `Connecting to ${t.name}…`
                : this.mode === "line"
                  ? "Line mode: this image has no script(1) · Ctrl-C interrupt · Ctrl-D end"
                  : `${this.size} · bash`
            }
          </span>
          <span class="spacer"></span>
          ${
            this.resized && this.status !== "exited"
              ? html`<span>Window resized</span>`
              : nothing
          }
          ${
            this.status === "exited" || this.resized
              ? html`
                  <button
                    class="btn small ghost"
                    @click=${() => this.startTerminal()}
                  >
                    ${icon("rotate-ccw", 12)}
                    ${this.status === "exited" ? "Reconnect" : "Reconnect to fit"}
                  </button>
                `
              : nothing
          }
        </div>
      </div>
    `;
  }

  static override styles = [
    sharedStyles,
    unsafeCSS(xtermCss),
    css`
      :host {
        display: flex;
        flex: 1;
        min-height: 0;
      }
      :host([hidden]) {
        display: none !important;
      }
      .term-pane {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .term-title {
        gap: 8px;
        padding: 8px 12px 8px 16px;
        border-bottom: 1px solid var(--border);
      }
      .term-body {
        flex: 1;
        min-height: 0;
        padding: 10px 6px 6px 14px;
        background: var(--console);
        cursor: text;
      }
      .term-host {
        width: 100%;
        height: 100%;
      }
      .term-host .xterm-viewport {
        background: transparent !important;
      }
      .term-banner {
        padding: 7px 16px;
        background: var(--warn-container);
        color: var(--on-warn-container);
        border-bottom: 1px solid var(--border);
      }
      .term-foot {
        padding: 7px 16px;
        gap: 8px;
        border-top: 1px solid var(--border);
      }
    `,
  ];
}

@customElement("ax-terminal")
export class AxTerminal extends LitElement {
  private offStore: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.offStore = store.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offStore?.();
  }

  override render() {
    const s = store.state;
    const tasks = [...s.tasks].sort(
      (a, b) => comparePhase(a.phase, b.phase) || a.name.localeCompare(b.name),
    );
    const openIDs = new Set(
      s.terminalTabs
        .filter((x) => x.context === s.context)
        .map((x) => x.task.id),
    );

    return html`
      <div class="terminal-page">
        <div class="terminal-head">
          <div class="page-header">
            <div>
              <h1>Terminal</h1>
              <p>Terminals into running tasks over <code>ax ssh</code>.</p>
            </div>
          </div>
        </div>
        <div class="terminal-layout">
          <aside class="card terminal-tasks" aria-label="Tasks in atespace">
            <div class="terminal-tasks-head caption faint">
              Tasks in ${s.atespace}
            </div>
            ${
              tasks.length === 0
                ? html`<p class="caption faint terminal-none">
                    No tasks in this atespace.
                  </p>`
                : tasks.map((t) => {
                    const running = t.phase === "running";
                    const open = openIDs.has(t.id);
                    const debugOff = s.details[t.id]?.debug === false;
                    return html`
                      <button
                        class="terminal-task ${open ? "open" : ""}"
                        ?disabled=${!running}
                        title=${
                          running
                            ? open
                              ? "Show its terminal"
                              : "Open a terminal"
                            : `${phaseLabel(t.phase)}: only running tasks have a terminal`
                        }
                        @click=${() => store.openTerminal(t)}
                      >
                        ${renderPhaseIcon(t.phase, 13)}
                        <span class="terminal-task-name"
                          ><bdi dir="ltr">${t.name}</bdi></span
                        >
                        ${
                          running && debugOff
                            ? html`<span
                                class="caption terminal-task-note"
                                title="Debug is off, so ax ssh may not connect"
                                >debug off</span
                              >`
                            : nothing
                        }
                        ${
                          !running
                            ? html`<span class="caption faint"
                                >${phaseLabel(t.phase)}</span
                              >`
                            : nothing
                        }
                        ${
                          open
                            ? html`<span class="terminal-task-dot"></span>`
                            : nothing
                        }
                      </button>
                    `;
                  })
            }
          </aside>

          <section class="card terminal-main" aria-label="Terminal sessions">
            ${
              s.terminalTabs.length > 0
                ? html`
                    <div class="terminal-tabs" role="tablist">
                      ${s.terminalTabs.map(
                        (tab) => html`
                          <div
                            role="tab"
                            aria-selected=${
                              tab.key === s.terminalActive ? "true" : "false"
                            }
                            class="terminal-tab ${
                              tab.key === s.terminalActive ? "on" : ""
                            }"
                            title="${tab.task.name} · ${tab.context}"
                            @mousedown=${(e: MouseEvent) => {
                              if (e.button === 1) store.closeTerminal(tab.key);
                              else store.set({ terminalActive: tab.key });
                            }}
                          >
                            ${icon("square-terminal", 13)}
                            <span>${tabLabel(tab, s.terminalTabs)}</span>
                            ${
                              tab.context !== s.context
                                ? html`<span class="faint"
                                    >· ${tab.context}</span
                                  >`
                                : nothing
                            }
                            <button
                              class="btn icon ghost terminal-tab-close"
                              title="Close session"
                              aria-label="Close session ${tab.task.name}"
                              @mousedown=${(e: Event) => e.stopPropagation()}
                              @click=${() => store.closeTerminal(tab.key)}
                            >
                              ${icon("x", 12)}
                            </button>
                          </div>
                        `,
                      )}
                    </div>
                  `
                : nothing
            }
            ${s.terminalTabs.map(
              (tab) => html`
                <ax-terminal-session
                  .tab=${tab}
                  .active=${tab.key === s.terminalActive}
                  ?hidden=${tab.key !== s.terminalActive}
                ></ax-terminal-session>
              `,
            )}
            ${
              s.terminalTabs.length === 0
                ? html`
                    <div class="terminal-empty">
                      <div class="empty">
                        ${icon("square-terminal", 28)}
                        <div
                          style="font-weight:600;color:var(--on-surface-variant)"
                        >
                          No open sessions
                        </div>
                        <div class="caption">
                          Pick a running task to open a terminal in its sandbox.
                        </div>
                      </div>
                    </div>
                  `
                : nothing
            }
          </section>
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
      .terminal-page {
        height: 100%;
        display: flex;
        flex-direction: column;
        min-height: 0;
        padding: 22px 28px 24px;
      }
      .terminal-head .page-header {
        margin-bottom: 16px;
      }
      .terminal-head code {
        font-size: 12px;
        background: var(--surface-container);
        padding: 0 4px;
        border-radius: 4px;
      }
      .terminal-layout {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 230px minmax(0, 1fr);
        gap: 14px;
      }
      .terminal-tasks {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 8px 6px;
        overflow: auto;
      }
      .terminal-tasks-head {
        padding: 2px 8px 6px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10.5px;
      }
      .terminal-none {
        padding: 4px 8px;
        margin: 0;
      }
      .terminal-task {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: var(--radius-s);
        border: 0;
        background: none;
        color: var(--on-surface);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .terminal-task:hover:not(:disabled) {
        background: var(--surface-container);
      }
      .terminal-task.open {
        background: var(--accent-soft);
      }
      .terminal-task:disabled {
        cursor: default;
        color: var(--text-3);
      }
      .terminal-task-name {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .terminal-task-note {
        color: var(--warn);
      }
      .terminal-task-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--green);
        flex: none;
      }
      .terminal-main {
        display: flex;
        flex-direction: column;
        min-height: 0;
        padding: 0;
        overflow: hidden;
      }
      .terminal-tabs {
        display: flex;
        gap: 2px;
        padding: 6px 6px 0;
        border-bottom: 1px solid var(--border);
        overflow-x: auto;
        overflow-y: hidden;
        flex: none;
        background: var(--surface-container);
      }
      .terminal-tab {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 4px 5px 10px;
        border-radius: 8px 8px 0 0;
        font-size: 12.5px;
        color: var(--on-surface-variant);
        cursor: pointer;
        white-space: nowrap;
        border: 1px solid transparent;
        border-bottom: 0;
        margin-bottom: -1px;
      }
      .terminal-tab:hover {
        background: var(--surface-container-high);
      }
      .terminal-tab.on {
        background: var(--surface-bright);
        color: var(--on-surface);
        border-color: var(--border);
      }
      .terminal-tab-close.btn {
        width: 20px;
        height: 20px;
        padding: 0;
        opacity: 0.6;
      }
      .terminal-tab:hover .terminal-tab-close.btn,
      .terminal-tab.on .terminal-tab-close.btn {
        opacity: 1;
      }
      .terminal-empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    `,
  ];
}
