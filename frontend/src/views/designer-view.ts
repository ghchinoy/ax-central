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

import { css, html, LitElement, nothing, svg, type TemplateResult } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { type IconName, icon } from "../icons";
import {
  type ConfigMode,
  type Draft,
  type KeyValue,
  TEMPLATES,
  type WorkspaceMode,
  canApply,
  cpuString,
  designer,
  formatEnv,
  generate,
  isSecret,
  issues,
  memoryString,
  parseEnv,
  tokenizeYAML,
  uid,
  validateEnvName,
  withID,
} from "../model/designer";
import {
  repoName,
  shortImage,
  validateImage,
  validateLabel,
} from "../model/resources";
import { store } from "../model/store";
import { sharedStyles } from "../shared-styles";

type ApplyResult = { ok: boolean; text: string } | null;

function updateRow<T extends { id: number }>(
  list: T[],
  id: number,
  patch: Partial<T>,
): T[] {
  return list.map((x) => (x.id === id ? { ...x, ...patch } : x));
}

const envRows = (text: string, prev: KeyValue[]): KeyValue[] =>
  parseEnv(text).map((kv, i) => ({ id: prev[i]?.id ?? uid(), ...kv }));

@customElement("ax-designer")
export class AxDesigner extends LitElement {
  @state() private result: ApplyResult = null;
  @state() private applying = false;
  @state() private createdTaskName: string | null = null;
  @state() private split =
    Number(localStorage.getItem("ax-central.designer.split")) || 0.5;
  @state() private templatesOpen = false;
  @state() private envMode: "form" | "text" = "form";
  @state() private envText = "";
  @state() private shownSecrets = new Set<number>();
  @state() private copied = false;
  @state() private resolvingDigest = false;
  @state() private digestMessage: string | null = null;
  @query(".split") private splitEl?: HTMLElement;

  private offDesigner: (() => void) | null = null;
  private offStore: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.offDesigner = designer.subscribe(() => {
      this.result = null;
      this.createdTaskName = null;
      this.requestUpdate();
    });
    this.offStore = store.subscribe(() => this.requestUpdate());
    window.addEventListener("ax:apply", this.onApplyEvent);
    window.addEventListener("mousedown", this.onWindowDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offDesigner?.();
    this.offStore?.();
    window.removeEventListener("ax:apply", this.onApplyEvent);
    window.removeEventListener("mousedown", this.onWindowDown);
  }

  private onWindowDown = (e: MouseEvent): void => {
    if (!this.templatesOpen) return;
    const path = e.composedPath();
    const dd = this.renderRoot.querySelector(".dropdown");
    if (dd && !path.includes(dd)) {
      this.templatesOpen = false;
    }
  };

  private onApplyEvent = (): void => {
    void this.apply();
  };

  private async apply(): Promise<void> {
    const draft = designer.draft;
    if (!canApply(draft) || this.applying || this.createdTaskName) return;
    this.applying = true;
    this.result = null;
    const r = await store.apply(generate(draft));
    this.result = { ok: r.ok, text: r.ok ? r.stdout.trim() : r.error };
    if (r.ok) {
      this.createdTaskName = draft.name;
    }
    this.applying = false;
  }

  private async resumeAndOpenCreated(): Promise<void> {
    const name = this.createdTaskName;
    if (!name) return;
    const ates = designer.draft.atespace || store.state.atespace || "default";
    const t = store.state.tasks.find((x) => x.name === name) ?? {
      id: `${ates}/${name}`,
      name,
      atespace: ates,
      phase: "suspended",
      age: "0s",
    };
    await store.resume(t);
    const refreshed = store.state.tasks.find((x) => x.name === name);
    store.set({ selectedTaskID: refreshed?.id ?? t.id });
    store.setSection("overview");
  }

  private viewCreatedInActivity(): void {
    const name = this.createdTaskName;
    if (!name) return;
    store.showTask(name);
  }

  private startDrag = (e: MouseEvent): void => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const r = this.splitEl?.getBoundingClientRect();
      if (!r) return;
      const f = Math.min(0.72, Math.max(0.3, (ev.clientX - r.left) / r.width));
      this.split = f;
      localStorage.setItem("ax-central.designer.split", String(f));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  private toggleShown(id: number): void {
    const next = new Set(this.shownSecrets);
    if (!next.delete(id)) next.add(id);
    this.shownSecrets = next;
  }

  private renderSection(
    iconName: IconName,
    tint: string,
    title: string,
    body: TemplateResult,
    trailing: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    return html`
      <section class="ds-card card">
        <header class="ds-header">
          <span class="ds-icon" style="--tint:${tint}"
            >${icon(iconName, 13)}</span
          >
          <h2>${title}</h2>
          <span class="spacer"></span>
          ${trailing}
        </header>
        <div class="ds-body">${body}</div>
      </section>
    `;
  }

  private renderField(
    label: string,
    control: TemplateResult,
    error?: string | null,
    warn = false,
    hint?: string,
  ): TemplateResult {
    return html`
      <div class="ds-field">
        <label>${label}</label>
        <div class="col" style="gap:3px;min-width:0">
          ${control}
          ${hint ? html`<span class="caption faint">${hint}</span>` : nothing}
          ${
            error
              ? html`<span class="ds-error caption ${warn ? "warn" : ""}"
                  >${error}</span
                >`
              : nothing
          }
        </div>
      </div>
    `;
  }

  private renderMeter(opts: {
    iconName: IconName;
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    display: string;
    ticks: string[];
    onChange: (v: number) => void;
  }): TemplateResult {
    const pct = ((opts.value - opts.min) / (opts.max - opts.min)) * 100;
    return html`
      <div class="meter">
        <div class="row meter-top">
          ${icon(opts.iconName, 14, { className: "faint" })}
          <span class="muted">${opts.label}</span>
          <span class="spacer"></span>
          <strong class="mono meter-value">${opts.display}</strong>
        </div>
        <div class="meter-track" style="--pct:${pct}%">
          <div class="meter-fill"></div>
          <input
            type="range"
            min=${opts.min}
            max=${opts.max}
            step=${opts.step}
            .value=${String(opts.value)}
            aria-label=${opts.label}
            @input=${(e: Event) =>
              opts.onChange(+(e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="meter-ticks caption faint">
          ${opts.ticks.map((t) => html`<span>${t}</span>`)}
        </div>
      </div>
    `;
  }

  private renderEnvironment(env: KeyValue[]): TemplateResult {
    const secrets = env.filter((kv) => isSecret(kv.key)).length;
    const onPaste = (kv: KeyValue) => (e: ClipboardEvent) => {
      const pasted = e.clipboardData?.getData("text") ?? "";
      if (!/^\s*(export\s+)?[A-Za-z_]\w*=/m.test(pasted)) return;
      const rows = envRows(pasted, []);
      if (rows.length === 0) return;
      e.preventDefault();
      const i = env.findIndex((x) => x.id === kv.id);
      const keep = kv.key || kv.value ? [env[i]] : [];
      designer.set({
        env: [...env.slice(0, i), ...keep, ...rows, ...env.slice(i + 1)],
      });
    };

    return this.renderSection(
      "variable",
      "var(--green)",
      "Environment",
      this.envMode === "text"
        ? html`
            <textarea
              class="textarea mono"
              rows=${Math.max(
                4,
                Math.min(14, this.envText.split("\n").length + 1),
              )}
              spellcheck="false"
              .value=${this.envText}
              placeholder=${"NAME=value\nAPI_KEY=..."}
              aria-label="Environment variables (.env format)"
              @input=${(e: Event) => {
                const val = (e.target as HTMLTextAreaElement).value;
                this.envText = val;
                designer.set({ env: envRows(val, env) });
              }}
            ></textarea>
            <p class="caption faint ds-hint">
              One <code>NAME=value</code> per line. Lines starting with # are
              ignored.
            </p>
          `
        : html`
            ${
              env.length === 0
                ? html`<p class="muted ds-hint">
                    Set variables for the task's process. Paste
                    <code>NAME=value</code> lines into a name to add several at
                    once.
                  </p>`
                : html`
                    <div class="env-grid">
                      <span class="caption faint">Name</span>
                      <span></span>
                      <span class="caption faint">Value</span>
                      <span></span>
                      ${env.map((kv) => {
                        const err = validateEnvName(kv.key, env);
                        const secret = isSecret(kv.key);
                        const visible = !secret || this.shownSecrets.has(kv.id);
                        return html`
                          <div class="col" style="gap:2px;min-width:0">
                            <input
                              class="input mono ${err ? "invalid" : ""}"
                              .value=${kv.key}
                              placeholder="NAME"
                              aria-label="Environment variable name"
                              spellcheck="false"
                              @paste=${onPaste(kv)}
                              @input=${(e: Event) =>
                                designer.set({
                                  env: updateRow(env, kv.id, {
                                    key: (e.target as HTMLInputElement).value,
                                  }),
                                })}
                            />
                            ${
                              err
                                ? html`<span class="ds-error caption"
                                    >${err}</span
                                  >`
                                : nothing
                            }
                          </div>
                          <span class="env-eq mono faint">=</span>
                          <div class="env-value ${secret ? "secret" : ""}">
                            ${
                              secret
                                ? html`<span class="env-lock"
                                    >${icon("lock", 12)}</span
                                  >`
                                : nothing
                            }
                            <input
                              class="input mono"
                              type=${visible ? "text" : "password"}
                              .value=${kv.value}
                              placeholder=${secret ? "required" : "value"}
                              aria-label="Environment variable value"
                              spellcheck="false"
                              @input=${(e: Event) =>
                                designer.set({
                                  env: updateRow(env, kv.id, {
                                    value: (e.target as HTMLInputElement).value,
                                  }),
                                })}
                            />
                            ${
                              secret
                                ? html`
                                    <button
                                      class="btn small icon ghost env-eye"
                                      title=${visible ? "Hide" : "Show"}
                                      aria-label=${
                                        visible ? "Hide secret" : "Show secret"
                                      }
                                      @click=${() => this.toggleShown(kv.id)}
                                    >
                                      ${icon(visible ? "eye-off" : "eye", 13)}
                                    </button>
                                  `
                                : nothing
                            }
                          </div>
                          <button
                            class="btn small icon ghost"
                            title="Remove"
                            aria-label="Remove variable"
                            @click=${() =>
                              designer.set({
                                env: env.filter((x) => x.id !== kv.id),
                              })}
                          >
                            ${icon("x", 13)}
                          </button>
                        `;
                      })}
                    </div>
                  `
            }
            <button
              class="btn small ghost ds-add"
              @click=${() =>
                designer.set({
                  env: [...env, { id: uid(), key: "", value: "" }],
                })}
            >
              ${icon("plus", 13)} Add variable
            </button>
          `,
      html`
        ${
          env.length > 0
            ? html`<span class="caption faint">
                ${env.length}
                ${env.length === 1 ? "variable" : "variables"}${
                  secrets ? ` · ${secrets} secret` : ""
                }
              </span>`
            : nothing
        }
        <div
          class="segmented"
          role="group"
          aria-label="Environment editor mode"
        >
          <button
            class=${this.envMode === "form" ? "on" : ""}
            @click=${() => (this.envMode = "form")}
          >
            Form
          </button>
          <button
            class=${this.envMode === "text" ? "on" : ""}
            @click=${() => {
              this.envText = formatEnv(env.filter((kv) => kv.key || kv.value));
              this.envMode = "text";
            }}
          >
            .env
          </button>
        </div>
      `,
    );
  }

  private renderNewWorkspace(d: Draft): TemplateResult {
    return html`
      ${this.renderField(
        "Name",
        html`<input
          class="input"
          aria-label="Workspace name"
          .value=${d.wsName}
          @input=${(e: Event) =>
            designer.set({ wsName: (e.target as HTMLInputElement).value })}
        />`,
        validateLabel(d.wsName),
      )}
      ${this.renderField(
        "Git repos",
        html`
          <div class="col" style="gap:6px">
            ${d.repos.map(
              (r) => html`
                <div class="ds-row">
                  <input
                    class="input"
                    style="flex:0 0 22%"
                    .value=${r.name}
                    placeholder="name"
                    aria-label="Repo alias"
                    @input=${(e: Event) =>
                      designer.set({
                        repos: updateRow(d.repos, r.id, {
                          name: (e.target as HTMLInputElement).value,
                        }),
                      })}
                  />
                  <input
                    class="input mono ${r.repo ? "" : "invalid"}"
                    .value=${r.repo}
                    placeholder="https://github.com/org/repo.git"
                    aria-label="Repository URL"
                    spellcheck="false"
                    @input=${(e: Event) =>
                      designer.set({
                        repos: updateRow(d.repos, r.id, {
                          repo: (e.target as HTMLInputElement).value,
                        }),
                      })}
                  />
                  <input
                    class="input mono"
                    style="flex:0 0 18%"
                    .value=${r.branch}
                    placeholder="branch"
                    aria-label="Branch"
                    @input=${(e: Event) =>
                      designer.set({
                        repos: updateRow(d.repos, r.id, {
                          branch: (e.target as HTMLInputElement).value,
                        }),
                      })}
                  />
                  <button
                    class="btn small icon ghost"
                    title="Remove"
                    aria-label="Remove repo"
                    @click=${() =>
                      designer.set({
                        repos: d.repos.filter((x) => x.id !== r.id),
                      })}
                  >
                    ${icon("x", 13)}
                  </button>
                </div>
              `,
            )}
            <button
              class="btn small ghost ds-add"
              @click=${() =>
                designer.set({
                  repos: [
                    ...d.repos,
                    {
                      id: uid(),
                      name: d.repos.length
                        ? `repo${d.repos.length + 1}`
                        : "origin",
                      repo: "",
                      branch: "main",
                    },
                  ],
                })}
            >
              ${icon("plus", 13)} Add repo
            </button>
          </div>
        `,
      )}
      ${this.renderField(
        "Files",
        html`
          <div class="col" style="gap:8px">
            ${d.files.map(
              (f) => html`
                <div class="ds-file">
                  <div class="ds-row">
                    <input
                      class="input mono"
                      .value=${f.path}
                      placeholder="path"
                      aria-label="File path"
                      @input=${(e: Event) =>
                        designer.set({
                          files: updateRow(d.files, f.id, {
                            path: (e.target as HTMLInputElement).value,
                          }),
                        })}
                    />
                    <button
                      class="btn small icon ghost"
                      title="Remove"
                      aria-label="Remove file"
                      @click=${() =>
                        designer.set({
                          files: d.files.filter((x) => x.id !== f.id),
                        })}
                    >
                      ${icon("x", 13)}
                    </button>
                  </div>
                  <textarea
                    class="textarea mono"
                    rows="3"
                    .value=${f.content}
                    placeholder="file contents"
                    aria-label="File contents"
                    spellcheck="false"
                    @input=${(e: Event) =>
                      designer.set({
                        files: updateRow(d.files, f.id, {
                          content: (e.target as HTMLTextAreaElement).value,
                        }),
                      })}
                  ></textarea>
                </div>
              `,
            )}
            <button
              class="btn small ghost ds-add"
              @click=${() =>
                designer.set({
                  files: [
                    ...d.files,
                    {
                      id: uid(),
                      path: d.files.length ? "" : "AGENTS.md",
                      content: "",
                    },
                  ],
                })}
            >
              ${icon("plus", 13)} Add file
            </button>
          </div>
        `,
      )}
      ${this.renderField(
        "MCP servers",
        html`
          <div class="col" style="gap:6px">
            ${d.servers.map(
              (sv) => html`
                <div class="ds-row">
                  <input
                    class="input"
                    style="flex:0 0 28%"
                    .value=${sv.name}
                    placeholder="name"
                    aria-label="MCP server name"
                    @input=${(e: Event) =>
                      designer.set({
                        servers: updateRow(d.servers, sv.id, {
                          name: (e.target as HTMLInputElement).value,
                        }),
                      })}
                  />
                  <input
                    class="input mono"
                    .value=${sv.endpoint}
                    placeholder="https://host/mcp"
                    aria-label="MCP server endpoint"
                    spellcheck="false"
                    @input=${(e: Event) =>
                      designer.set({
                        servers: updateRow(d.servers, sv.id, {
                          endpoint: (e.target as HTMLInputElement).value,
                        }),
                      })}
                  />
                  <button
                    class="btn small icon ghost"
                    title="Remove"
                    aria-label="Remove server"
                    @click=${() =>
                      designer.set({
                        servers: d.servers.filter((x) => x.id !== sv.id),
                      })}
                  >
                    ${icon("x", 13)}
                  </button>
                </div>
              `,
            )}
            <button
              class="btn small ghost ds-add"
              @click=${() =>
                designer.set({
                  servers: [
                    ...d.servers,
                    { id: uid(), name: "", endpoint: "" },
                  ],
                })}
            >
              ${icon("plus", 13)} Add server
            </button>
          </div>
        `,
      )}
    `;
  }

  private renderForm(d: Draft): TemplateResult {
    const s = store.state;
    if (d.rawMode) {
      return html`
        <div class="ds-form">
          <div class="ds-card card ds-raw">
            ${icon("file-code", 22, { className: "faint" })}
            <div class="col" style="gap:2px">
              <strong>Editing YAML directly</strong>
              <span class="muted"
                >The form is paused while you edit the manifest on the
                right.</span
              >
            </div>
            <span class="spacer"></span>
            <button
              class="btn"
              @click=${() => designer.set({ rawMode: false })}
            >
              Back to the visual editor
            </button>
          </div>
        </div>
      `;
    }

    const nameErr = validateLabel(d.name);
    const atesErr = d.atespace ? validateLabel(d.atespace) : null;
    const imgErr = d.image.includes("REPLACE_WITH")
      ? "replace the placeholder digest"
      : validateImage(d.image);

    return html`
      <div class="ds-form">
        ${this.renderSection(
          "box",
          "var(--primary)",
          "Task",
          html`
            ${this.renderField(
              "Name",
              html`<input
                class="input ${nameErr ? "invalid" : ""}"
                aria-label="Task name"
                .value=${d.name}
                @input=${(e: Event) =>
                  designer.set({ name: (e.target as HTMLInputElement).value })}
              />`,
              nameErr,
            )}
            ${this.renderField(
              "Atespace",
              html`<input
                class="input ${atesErr ? "invalid" : ""}"
                aria-label="Atespace"
                .value=${d.atespace}
                placeholder=${s.atespace}
                @input=${(e: Event) =>
                  designer.set({
                    atespace: (e.target as HTMLInputElement).value,
                  })}
              />`,
              atesErr,
            )}
            ${this.renderField(
              "Image",
              html`
                <div class="col" style="gap:6px">
                  <div class="row" style="gap:6px">
                    <select
                      class="input"
                      style="flex:1"
                      aria-label="Select image from registry catalog"
                      .value=${""}
                      @change=${(e: Event) => {
                        const sel = e.target as HTMLSelectElement;
                        if (sel.value) {
                          designer.set({ image: sel.value });
                          this.digestMessage = null;
                          sel.value = "";
                        }
                      }}
                    >
                      <option value="">
                        Pick from image registry catalog…
                      </option>
                      ${designer.registries.map(
                        (reg) => html`
                          <optgroup label=${reg.title}>
                            ${reg.images.map((img) => {
                              const ref = `${reg.prefix}/${img.name}${
                                img.digest ? `@${img.digest}` : ":latest"
                              }`;
                              return html`
                                <option value=${ref}>
                                  ${reg.prefix}/${img.name}${
                                    img.digest
                                      ? ` (@${img.digest.slice(0, 14)}…)`
                                      : " (:latest)"
                                  }
                                </option>
                              `;
                            })}
                          </optgroup>
                        `,
                      )}
                      <optgroup label="Local Apple Container / Podman">
                        <option value="ax-agent-local:latest">
                          ax-agent-local:latest (local agent image)
                        </option>
                        <option value="dgem-genkit-task:latest">
                          dgem-genkit-task:latest (local dgem + genkit)
                        </option>
                        <option value="debian:12">
                          debian:12 (minimal shell)
                        </option>
                      </optgroup>
                    </select>
                    <button
                      class="btn small"
                      ?disabled=${!d.image.trim() || this.resolvingDigest}
                      title="Resolve and pin the @sha256: manifest digest for this image"
                      @click=${async () => {
                        this.resolvingDigest = true;
                        this.digestMessage = null;
                        const res = await designer.resolveDigest();
                        this.resolvingDigest = false;
                        this.digestMessage = res.error ?? null;
                      }}
                    >
                      ${icon(this.resolvingDigest ? "loader" : "lock", 12, {
                        className: this.resolvingDigest ? "spin" : "",
                      })}
                      Resolve @sha256:
                    </button>
                    <button
                      class="btn small ghost icon"
                      title="Configure image registries in Settings"
                      aria-label="Configure image registries"
                      @click=${() => store.set({ settingsOpen: true })}
                    >
                      ${icon("settings", 12)}
                    </button>
                  </div>
                  <input
                    class="input mono"
                    aria-label="Image"
                    .value=${d.image}
                    placeholder="server default runner"
                    spellcheck="false"
                    @input=${(e: Event) => {
                      this.digestMessage = null;
                      designer.set({
                        image: (e.target as HTMLInputElement).value,
                      });
                    }}
                  />
                  ${
                    this.digestMessage
                      ? html`<span class="caption" style="color:var(--orange)"
                          >${this.digestMessage}</span
                        >`
                      : nothing
                  }
                </div>
              `,
              imgErr,
              !d.image.includes("REPLACE_WITH"),
            )}
            ${this.renderField(
              "Command",
              html`<input
                class="input mono"
                aria-label="Command"
                .value=${d.command}
                placeholder="runner decides"
                spellcheck="false"
                @input=${(e: Event) =>
                  designer.set({
                    command: (e.target as HTMLInputElement).value,
                  })}
              />`,
              null,
              false,
              "Overrides the container entrypoint (spec.command argv). Leave blank to let the runner image use its default entrypoint.",
            )}
          `,
        )}
        ${this.renderEnvironment(d.env)}
        ${this.renderSection(
          "cpu",
          "var(--orange)",
          "Sandbox",
          html`
            ${this.renderMeter({
              iconName: "cpu",
              label: "CPU",
              value: d.cpu,
              min: 0.25,
              max: 8,
              step: 0.25,
              display: cpuString(d.cpu),
              ticks: ["250m", "2", "4", "6", "8"],
              onChange: (cpu) => designer.set({ cpu }),
            })}
            ${this.renderMeter({
              iconName: "memory",
              label: "Memory",
              value: d.memoryMi,
              min: 256,
              max: 16384,
              step: 256,
              display: memoryString(d.memoryMi),
              ticks: ["256Mi", "4Gi", "8Gi", "12Gi", "16Gi"],
              onChange: (memoryMi) => designer.set({ memoryMi }),
            })}
            <div class="ds-toggle-row">
              <div class="col">
                <span>Debug</span>
                <span class="caption faint"
                  >Serves guest services so <code>ax ssh</code> works</span
                >
              </div>
              <label class="toggle" title="Toggle debug">
                <input
                  type="checkbox"
                  aria-label="Debug"
                  .checked=${d.debug}
                  @change=${(e: Event) =>
                    designer.set({
                      debug: (e.target as HTMLInputElement).checked,
                    })}
                />
                <span></span>
              </label>
            </div>
          `,
        )}
        ${this.renderSection(
          "sparkles",
          "var(--orange)",
          "Runner config",
          d.configMode === "none"
            ? html`<p class="muted ds-hint">
                The runner image runs its command with no extra config.
              </p>`
            : html`<textarea
                class="textarea mono"
                rows="6"
                spellcheck="false"
                aria-label="Custom runner YAML config"
                .value=${d.customConfig}
                @input=${(e: Event) =>
                  designer.set({
                    customConfig: (e.target as HTMLTextAreaElement).value,
                  })}
              ></textarea>`,
          html`
            <div class="segmented" role="group" aria-label="Runner config mode">
              ${(["none", "custom"] as ConfigMode[]).map(
                (m) => html`
                  <button
                    class=${d.configMode === m ? "on" : ""}
                    @click=${() => designer.set({ configMode: m })}
                  >
                    ${m === "none" ? "None" : "Custom YAML"}
                  </button>
                `,
              )}
            </div>
          `,
        )}
        ${this.renderSection(
          "folder-git",
          "var(--purple)",
          "Workspace",
          d.workspaceMode === "none"
            ? html`<p class="muted ds-hint">
                The task gets an empty <code>/workspace</code>.
              </p>`
            : d.workspaceMode === "existing"
              ? this.renderField(
                  "Workspace",
                  html`<select
                    class="select"
                    aria-label="Existing workspace"
                    .value=${d.existingWorkspace}
                    @change=${(e: Event) =>
                      designer.set({
                        existingWorkspace: (e.target as HTMLSelectElement)
                          .value,
                      })}
                  >
                    <option value="">Choose…</option>
                    ${s.workspaces.map(
                      (w) => html`
                        <option
                          value=${w.name}
                          ?selected=${w.name === d.existingWorkspace}
                        >
                          ${w.name} (${w.gitCount}
                          repo${w.gitCount === 1 ? "" : "s"}, ${w.mcpCount} MCP)
                        </option>
                      `,
                    )}
                  </select>`,
                )
              : this.renderNewWorkspace(d),
          html`
            <div class="segmented" role="group" aria-label="Workspace mode">
              ${(["none", "existing", "new"] as WorkspaceMode[]).map(
                (m) => html`
                  <button
                    class=${d.workspaceMode === m ? "on" : ""}
                    @click=${() => designer.set({ workspaceMode: m })}
                  >
                    ${
                      m === "none"
                        ? "None"
                        : m === "existing"
                          ? "Existing"
                          : "New"
                    }
                  </button>
                `,
              )}
            </div>
          `,
        )}
        ${this.renderSection(
          "cpu",
          "var(--teal)",
          "Model",
          !d.includeModel
            ? html`<p class="muted ds-hint">
                Optionally create a Model resource alongside the task.
              </p>`
            : html`
                ${this.renderField(
                  "Name",
                  html`<input
                    class="input"
                    aria-label="Model resource name"
                    .value=${d.modelName}
                    @input=${(e: Event) =>
                      designer.set({
                        modelName: (e.target as HTMLInputElement).value,
                      })}
                  />`,
                  validateLabel(d.modelName),
                )}
                ${this.renderField(
                  "Provider",
                  html`<input
                    class="input"
                    aria-label="Model provider"
                    .value=${d.provider}
                    @input=${(e: Event) =>
                      designer.set({
                        provider: (e.target as HTMLInputElement).value,
                      })}
                  />`,
                )}
                ${this.renderField(
                  "Model ID",
                  html`<input
                    class="input mono"
                    aria-label="Model ID"
                    .value=${d.modelID}
                    @input=${(e: Event) =>
                      designer.set({
                        modelID: (e.target as HTMLInputElement).value,
                      })}
                  />`,
                )}
                ${this.renderField(
                  "Secret",
                  html`<div class="ds-row">
                    <input
                      class="input mono"
                      aria-label="Secret name"
                      .value=${d.secretName}
                      placeholder="secret name"
                      @input=${(e: Event) =>
                        designer.set({
                          secretName: (e.target as HTMLInputElement).value,
                        })}
                    />
                    <input
                      class="input mono"
                      aria-label="Secret key"
                      .value=${d.secretKey}
                      placeholder="key"
                      @input=${(e: Event) =>
                        designer.set({
                          secretKey: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </div>`,
                )}
                ${this.renderField(
                  "Max tokens",
                  html`<input
                    class="input"
                    type="number"
                    min="0"
                    style="width:120px"
                    aria-label="Max tokens"
                    .value=${String(d.maxTokens)}
                    @input=${(e: Event) =>
                      designer.set({
                        maxTokens: Math.max(
                          0,
                          +(e.target as HTMLInputElement).value || 0,
                        ),
                      })}
                  />`,
                )}
              `,
          html`
            <label class="toggle" title="Include a Model resource">
              <input
                type="checkbox"
                aria-label="Include Model resource"
                .checked=${d.includeModel}
                @change=${(e: Event) =>
                  designer.set({
                    includeModel: (e.target as HTMLInputElement).checked,
                  })}
              />
              <span></span>
            </label>
          `,
        )}
      </div>
    `;
  }

  private renderCompositionDiagram(d: Draft): TemplateResult {
    if (d.rawMode) {
      return html`
        <div class="cd-raw muted">
          ${icon("file-code", 22)}
          <strong>Raw YAML mode — applied as written.</strong>
        </div>
      `;
    }
    const sources = d.repos.length + d.files.length + d.servers.length;
    const renderConnector = (
      color: string,
      label: string,
      dashed = false,
    ) => html`
      <div class="cd-connector fade-in">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
          ${svg`<path
            d="M0 20 C 35 4, 65 36, 100 20"
            fill="none"
            stroke=${color}
            stroke-width="2"
            stroke-dasharray=${dashed ? "5 5" : "none"}
            vector-effect="non-scaling-stroke"
            opacity="0.7"
          />
          ${
            !dashed
              ? svg`<circle r="3" fill=${color}>
                  <animateMotion dur="1.8s" repeatCount="indefinite" path="M0 20 C 35 4, 65 36, 100 20" />
                </circle>`
              : nothing
          }`}
        </svg>
        <span class="caption faint">${label}</span>
      </div>
    `;

    return html`
      <div class="cd">
        ${
          d.workspaceMode !== "none"
            ? html`
                <div class="cd-node card fade-in" style="--tint:var(--purple)">
                  <div class="cd-kind">Workspace</div>
                  <div class="row" style="gap:10px">
                    <div class="cd-tile">${icon("folder-git", 17)}</div>
                    <div class="col" style="min-width:0">
                      <strong class="ellipsis">
                        ${
                          d.workspaceMode === "existing"
                            ? d.existingWorkspace || "pick a workspace"
                            : d.wsName || "—"
                        }
                      </strong>
                      <span class="caption muted ellipsis">
                        ${
                          d.workspaceMode === "existing"
                            ? "existing workspace"
                            : `${sources} source${sources === 1 ? "" : "s"}`
                        }
                      </span>
                    </div>
                  </div>
                  ${
                    d.workspaceMode === "new" && sources > 0
                      ? html`
                          <div class="cd-chips">
                            ${d.repos.map(
                              (r) => html`
                                <span class="chip">
                                  ${icon("git-branch", 10)}
                                  ${r.repo ? repoName(r.repo) : r.name || "repo"}
                                </span>
                              `,
                            )}
                            ${d.files.map(
                              (f) => html`
                                <span class="chip">
                                  ${icon("file-text", 10)} ${f.path || "file"}
                                </span>
                              `,
                            )}
                            ${d.servers.map(
                              (s) => html`
                                <span class="chip">
                                  ${icon("plug", 10)} ${s.name || "mcp"}
                                </span>
                              `,
                            )}
                          </div>
                        `
                      : nothing
                  }
                </div>
                ${renderConnector("var(--purple)", "/workspace")}
              `
            : nothing
        }

        <div class="cd-node card fade-in" style="--tint:var(--primary)">
          <div class="cd-kind">Task</div>
          <div class="row" style="gap:10px">
            <div class="cd-tile">${icon("box", 17)}</div>
            <div class="col" style="min-width:0">
              <strong class="ellipsis">${d.name || "—"}</strong>
              <span class="caption muted ellipsis">
                ${d.image ? shortImage(d.image) : "default runner image"}
              </span>
            </div>
          </div>
          <div class="cd-chips">
            <span class="chip">${icon("cpu", 10)} ${cpuString(d.cpu)} CPU</span>
            <span class="chip">${memoryString(d.memoryMi)}</span>
            ${d.debug ? html`<span class="chip">debug</span>` : nothing}
          </div>
        </div>

        ${
          d.includeModel
            ? html`
                ${renderConnector("var(--teal)", "model", true)}
                <div class="cd-node card fade-in" style="--tint:var(--teal)">
                  <div class="cd-kind">Model</div>
                  <div class="row" style="gap:10px">
                    <div class="cd-tile">${icon("cpu", 17)}</div>
                    <div class="col" style="min-width:0">
                      <strong class="ellipsis">${d.modelName || "—"}</strong>
                      <span class="caption muted ellipsis"
                        >${d.provider} · ${d.modelID}</span
                      >
                    </div>
                  </div>
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  private renderYamlToken = (t: {
    cls: string;
    text: string;
  }): TemplateResult => html`<span class="yaml-tok ${t.cls}">${t.text}</span>`;

  private renderYamlLine = (
    toks: { cls: string; text: string }[],
  ): TemplateResult => {
    const inner = toks.length === 0 ? "\u200b" : toks.map(this.renderYamlToken);
    return html`<div class="yaml-line">${inner}</div>`;
  };

  private renderYamlPane(d: Draft): TemplateResult {
    const text = generate(d, true);
    const docs = text.split(/^---\s*$/m).filter((x) => x.trim()).length;
    const lines = tokenizeYAML(text);
    const rawLines = d.rawYAML.replace(/\n$/, "").split("\n");
    const displayLines = d.rawMode ? rawLines : lines;

    const copy = async () => {
      await navigator.clipboard.writeText(generate(d));
      this.copied = true;
      setTimeout(() => (this.copied = false), 1400);
    };

    return html`
      <div class="yaml-pane">
        <div class="yaml-head">
          ${icon("file-code", 14, { className: "faint" })}
          <strong>${d.rawMode ? "Manifest" : "Generated YAML"}</strong>
          <span class="chip">${docs} object${docs === 1 ? "" : "s"}</span>
          ${
            d.filePath
              ? html`<span class="caption faint ellipsis" title=${d.filePath}
                  >${d.filePath.split(/[\\/]/).pop()}</span
                >`
              : nothing
          }
          <span class="spacer"></span>
          <label class="row caption muted" style="gap:6px;cursor:pointer">
            Edit raw
            <span class="toggle">
              <input
                type="checkbox"
                aria-label="Edit raw YAML"
                .checked=${d.rawMode}
                @change=${(e: Event) => {
                  const on = (e.target as HTMLInputElement).checked;
                  if (on) designer.enterRawMode();
                  else designer.set({ rawMode: false });
                }}
              />
              <span></span>
            </span>
          </label>
          <button
            class="btn small"
            title="Copy the manifest (with secrets)"
            @click=${() => void copy()}
          >
            ${icon(this.copied ? "check" : "copy", 13)}
            ${this.copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div
          class="yaml-view selectable"
          tabindex=${d.rawMode ? -1 : 0}
          role="region"
          aria-label="Generated YAML"
        >
          <div class="yaml-gutter" aria-hidden="true">
            ${displayLines.map((_, i) => html`<div>${i + 1}</div>`)}
          </div>
          ${
            d.rawMode
              ? html`<textarea
                  class="yaml-raw mono"
                  spellcheck="false"
                  wrap="off"
                  aria-label="Raw YAML manifest"
                  .value=${d.rawYAML}
                  @scroll=${(e: Event) => {
                    const ta = e.currentTarget as HTMLTextAreaElement;
                    const gutter =
                      this.renderRoot.querySelector<HTMLElement>(
                        ".yaml-gutter",
                      );
                    if (gutter) {
                      gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
                    }
                  }}
                  @input=${(e: Event) =>
                    designer.set({
                      rawYAML: (e.target as HTMLTextAreaElement).value,
                    })}
                ></textarea>`
              : html`<pre class="yaml-code">
${lines.map(this.renderYamlLine)}</pre>`
          }
        </div>
      </div>
    `;
  }

  override render() {
    const d = designer.draft;
    const s = store.state;
    const list = issues(d);

    return html`
      <div class="designer">
        <div class="designer-head">
          <div class="page-header">
            <div>
              <h1>Deploy</h1>
              <p>Compose a task, its workspace and model, then create them.</p>
            </div>
            <div class="spacer"></div>
            <div class="row">
              <div class="dropdown">
                <button
                  class="btn"
                  @click=${() => (this.templatesOpen = !this.templatesOpen)}
                >
                  ${icon("layout-grid", 14)} Templates
                  ${icon("chevron-down", 12, { className: "faint" })}
                </button>
                ${
                  this.templatesOpen
                    ? html`
                        <div class="menu card fade-in">
                          ${TEMPLATES.map(
                            (t, i) => html`
                              ${
                                t.group && t.group !== TEMPLATES[i - 1]?.group
                                  ? html`
                                      <div class="menu-sep"></div>
                                      <div class="menu-heading caption faint">
                                        ${t.group}
                                      </div>
                                    `
                                  : nothing
                              }
                              <button
                                class="menu-item"
                                @click=${() => {
                                  designer.load(t.id);
                                  this.templatesOpen = false;
                                }}
                              >
                                <span class="menu-check"></span>
                                ${t.title}
                              </button>
                            `,
                          )}
                        </div>
                      `
                    : nothing
                }
              </div>
              <button
                class="btn"
                title="Open manifest (⌘O)"
                @click=${() => void designer.open(s.settings.repoPath)}
              >
                ${icon("folder-open", 14)} Open
              </button>
              <button
                class="btn"
                title="Save manifest (⌘S)"
                @click=${() => void designer.save()}
              >
                ${icon("save", 14)} Save
              </button>
              <button
                class="btn primary"
                ?disabled=${!canApply(d) || this.applying || !!this.createdTaskName}
                title="Create (⌘↩)"
                @click=${() => void this.apply()}
              >
                ${icon(this.createdTaskName ? "check" : "play", 13)}
                ${
                  this.applying
                    ? "Creating…"
                    : this.createdTaskName
                      ? "Created"
                      : "Create"
                }
              </button>
              ${
                this.createdTaskName
                  ? html`
                      <button
                        class="btn primary"
                        title="Resume ${this.createdTaskName} and open in Activity"
                        @click=${() => void this.resumeAndOpenCreated()}
                      >
                        ${icon("play", 13)} Resume & Open in Activity
                      </button>
                      <button
                        class="btn"
                        title="Generate a fresh task ID to create another copy"
                        @click=${() =>
                          designer.set({ name: withID(designer.draft.name) })}
                      >
                        ${icon("plus", 13)} New Task ID
                      </button>
                    `
                  : nothing
              }
            </div>
          </div>
        </div>

        <div class="split">
          <div class="split-pane" style="flex-basis:${this.split * 100}%">
            ${this.renderForm(d)}
          </div>
          <div class="split-handle" @mousedown=${this.startDrag}>
            <span></span>
          </div>
          <div class="split-pane split-right">
            <div class="designer-right">
              <div class="designer-diagram dotgrid">
                ${this.renderCompositionDiagram(d)}
              </div>
              ${this.renderYamlPane(d)}
            </div>
          </div>
        </div>

        <footer class="designer-foot">
          <div class="foot-issues">
            ${
              list.length === 0
                ? html`<span class="row foot-ok">
                    ${icon("circle-check", 14)}
                    ${
                      d.rawMode
                        ? "Raw manifest — validated by the server on apply"
                        : "Ready to apply"
                    }
                  </span>`
                : list.map(
                    (i) => html`
                      <span class="row foot-issue ${i.severity}">
                        ${icon(
                          i.severity === "error" ? "circle-x" : "alert",
                          13,
                        )}
                        ${i.text}
                      </span>
                    `,
                  )
            }
          </div>
          ${
            this.result
              ? html`
                  <div
                    class="foot-result fade-in ${this.result.ok ? "ok" : "err"}"
                    title=${this.result.text}
                  >
                    ${icon(this.result.ok ? "circle-check" : "circle-x", 14)}
                    <span class="ellipsis selectable">
                      ${
                        this.result.text ||
                        (this.result.ok ? "Created" : "Failed")
                      }
                    </span>
                    ${
                      this.result.ok && this.createdTaskName
                        ? html`
                            <button
                              class="btn small ghost"
                              @click=${() => this.viewCreatedInActivity()}
                            >
                              View in Activity →
                            </button>
                          `
                        : nothing
                    }
                  </div>
                `
              : nothing
          }
        </footer>
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
      .designer {
        height: 100%;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .designer-head {
        padding: 22px 28px 0;
        flex: none;
      }
      .designer-head .page-header {
        margin-bottom: 16px;
      }

      /* Split */
      .split {
        flex: 1;
        min-height: 0;
        display: flex;
        border-top: 1px solid var(--border);
      }
      .split-pane {
        min-width: 0;
        min-height: 0;
        overflow: auto;
      }
      .split-right {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .split-handle {
        flex: none;
        width: 7px;
        margin: 0 -3px;
        cursor: col-resize;
        position: relative;
        z-index: 2;
        display: flex;
        justify-content: center;
      }
      .split-handle span {
        width: 1px;
        height: 100%;
        background: var(--border);
        transition:
          background var(--duration-fast),
          width var(--duration-fast);
      }
      .split-handle:hover span {
        background: var(--primary);
        width: 2px;
      }

      /* Form */
      .ds-form {
        padding: 18px 20px 28px 28px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .ds-card {
        overflow: visible;
      }
      .ds-header {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 11px 14px;
        border-bottom: 1px solid var(--border);
      }
      .ds-header h2 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
      }
      .ds-icon {
        width: 22px;
        height: 22px;
        border-radius: 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--tint);
        background: color-mix(in srgb, var(--tint) 15%, transparent);
      }
      .ds-body {
        padding: 12px 14px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .ds-field {
        display: grid;
        grid-template-columns: 96px 1fr;
        gap: 10px;
        align-items: start;
      }
      .ds-field > label {
        color: var(--on-surface-variant);
        text-align: right;
        padding-top: 6px;
      }
      .ds-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .ds-row .input {
        flex: 1;
      }
      .ds-file {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 8px;
        border-radius: var(--radius-s);
        background: var(--surface-container);
      }
      .ds-add {
        align-self: flex-start;
        color: var(--primary);
      }
      .ds-error {
        color: var(--danger);
      }
      .ds-error.warn {
        color: var(--warn);
      }
      .ds-hint {
        margin: 0;
        font-size: 12px;
      }
      .ds-toggle-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 10px;
        border-radius: var(--radius-s);
        background: var(--surface-container);
      }
      .ds-toggle-row > .col {
        flex: 1;
        gap: 2px;
      }
      .ds-raw {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px;
      }
      .ds-form code,
      .ds-toggle-row code {
        font-size: 11px;
        background: var(--surface-container);
        padding: 0 4px;
        border-radius: 4px;
      }

      /* Meter */
      .meter {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .meter-top {
        gap: 7px;
      }
      .meter-value {
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }
      .meter-track {
        position: relative;
        height: 10px;
        border-radius: 5px;
        background: var(--surface-container);
        border: 1px solid var(--border);
      }
      .meter-fill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: var(--pct);
        border-radius: 5px;
        background: linear-gradient(
          90deg,
          color-mix(in srgb, var(--primary) 55%, transparent),
          var(--primary)
        );
        transition: width 0.12s ease-out;
      }
      .meter-track input[type="range"] {
        position: absolute;
        inset: -6px 0;
        width: 100%;
        margin: 0;
        opacity: 0;
        cursor: pointer;
        height: 22px;
      }
      .meter-track::after {
        content: "";
        position: absolute;
        top: 50%;
        left: var(--pct);
        width: 16px;
        height: 16px;
        margin: -8px 0 0 -8px;
        border-radius: 50%;
        background: #fff;
        border: 1px solid var(--outline-variant);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
        pointer-events: none;
        transition: left 0.12s ease-out;
      }
      .meter-ticks {
        display: flex;
        justify-content: space-between;
        font-variant-numeric: tabular-nums;
      }

      /* Right side */
      .designer-right {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .designer-diagram {
        flex: none;
        height: 220px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        overflow: hidden;
      }
      .cd {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
      }
      .cd-node {
        position: relative;
        width: 200px;
        flex: 0 1 200px;
        min-width: 150px;
        padding: 18px 12px 12px;
        display: flex;
        flex-direction: column;
        gap: 9px;
        border-color: color-mix(in srgb, var(--tint) 35%, var(--border));
        transition:
          transform var(--duration-medium),
          box-shadow var(--duration-medium);
      }
      .cd-node:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-2);
      }
      .cd-kind {
        position: absolute;
        top: -8px;
        left: 10px;
        padding: 0 6px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--tint);
        background: var(--surface-bright);
        border-radius: 4px;
        border: 1px solid color-mix(in srgb, var(--tint) 30%, var(--border));
      }
      .cd-tile {
        width: 32px;
        height: 32px;
        flex: none;
        border-radius: var(--radius-s);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--tint);
        background: color-mix(in srgb, var(--tint) 14%, transparent);
      }
      .cd-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        max-height: 48px;
        overflow: hidden;
      }
      .cd-chips .chip {
        height: 18px;
        font-size: 10px;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cd-connector {
        flex: 1 1 60px;
        min-width: 40px;
        max-width: 120px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      .cd-connector svg {
        width: 100%;
        height: 40px;
        overflow: visible;
      }
      .cd-raw {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      /* YAML */
      .yaml-pane {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--surface-bright);
      }
      .yaml-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px 8px 16px;
        border-bottom: 1px solid var(--border);
        flex: none;
      }
      .yaml-view {
        flex: 1;
        min-height: 0;
        overflow: auto;
        display: flex;
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 19px;
      }
      .yaml-gutter {
        flex: none;
        padding: 10px 10px 16px 12px;
        text-align: right;
        color: var(--text-3);
        opacity: 0.7;
        user-select: none;
        border-right: 1px solid var(--border);
        background: var(--surface-bright);
        position: sticky;
        left: 0;
        font-variant-numeric: tabular-nums;
      }
      .yaml-code {
        margin: 0;
        padding: 10px 16px 16px 12px;
        flex: 1;
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 19px;
      }
      .yaml-line {
        display: flex;
        min-height: 19px;
      }
      .yaml-tok {
        white-space: pre;
      }
      .yaml-raw {
        flex: 1;
        min-height: 0;
        resize: none;
        border: 0;
        outline: none;
        margin: 0;
        padding: 10px 16px 16px 12px;
        background: var(--surface-bright);
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 19px;
        white-space: pre;
        tab-size: 2;
      }
      .y-key {
        color: var(--primary);
      }
      .y-str,
      .y-block {
        color: var(--green);
      }
      .y-num {
        color: var(--orange);
      }
      .y-punct {
        color: var(--text-3);
      }
      .y-comment {
        color: var(--text-3);
        font-style: italic;
      }
      .y-sep {
        color: var(--purple);
        font-weight: 600;
      }
      .y-plain {
        color: var(--on-surface);
      }

      /* Footer */
      .designer-foot {
        flex: none;
        display: flex;
        align-items: center;
        gap: 16px;
        min-height: 40px;
        padding: 6px 16px 6px 28px;
        border-top: 1px solid var(--border);
        background: var(--surface-container-low);
      }
      .foot-issues {
        flex: 1;
        display: flex;
        flex-wrap: wrap;
        gap: 4px 16px;
        min-width: 0;
        font-size: 12px;
      }
      .foot-ok {
        color: var(--green);
        gap: 6px;
        font-weight: 500;
      }
      .foot-issue {
        gap: 5px;
      }
      .foot-issue.error {
        color: var(--danger);
      }
      .foot-issue.warning {
        color: var(--warn);
      }
      .foot-result {
        display: flex;
        align-items: center;
        gap: 6px;
        max-width: 45%;
        padding: 4px 10px;
        border-radius: var(--radius-s);
        font-size: 12px;
      }
      .foot-result.ok {
        color: var(--on-ok-container);
        background: var(--ok-container);
      }
      .foot-result.err {
        color: var(--on-danger-container);
        background: var(--danger-container);
      }

      /* Environment */
      .env-grid {
        display: grid;
        grid-template-columns: minmax(0, 2fr) auto minmax(0, 3fr) auto;
        gap: 6px;
        align-items: start;
      }
      .env-grid .input {
        width: 100%;
      }
      .env-eq {
        padding-top: 6px;
      }
      .env-value {
        position: relative;
        display: flex;
        align-items: center;
        min-width: 0;
      }
      .env-value.secret .input {
        padding-left: 26px;
        padding-right: 30px;
      }
      .env-lock {
        position: absolute;
        left: 9px;
        color: var(--warn);
        pointer-events: none;
        display: flex;
      }
      .env-eye.btn {
        position: absolute;
        right: 2px;
      }
    `,
  ];
}
