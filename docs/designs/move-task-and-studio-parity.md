# Cross-Substrate Task Migration and AX Studio Feature Parity

*   **Author:** G. H. Chinoy
*   **Status:** Approved (EGM Goldfish Reviewed)
*   **Date:** 2026-11-07
*   **Beads:** `ax-central-n0a` (`ax-central-n0a.1` .. `ax-central-n0a.6`)

--------------------------------------------------------------------------------

## Overview

This design specifies four capabilities ported from `~/projects/ax-studio` (`commits e01c326, 2ae9dac, f26a2f1, ef99360, fd88599, 2237f4c`) and adapted for AX Central's dual-substrate architecture (`local` Apple `container` microVMs and Kubernetes `kind` / GKE clusters) and WebMCP `ToolHost`:

1.  **Cross-Context and Cross-Atespace Task Migration (`Move Task`)**: Recreates a task and its workspace in a destination context or atespace and streams `/workspace` files directly between the source and destination sandboxes over `ax ssh` (`tar cf - | tar xf -`) via a Go process pipe (`Shell.Pipe`).
2.  **Podman `buildx --metadata-file` Support (`docker-shim.sh`)**: Writes the pushed image name and registry manifest digest to the file requested by `--metadata-file` during `docker buildx build --push`.
3.  **`ax-images` v0.5.0 Presets (`designer.ts`)**: Adds the `antigravity` (`Antigravity Agent`) preset, updates `claude-managed-agents` and `github-actions` to `rakyll/ax-images` v0.5.0 digests and nested `agent:` configuration, and updates the sample Python workspace repository to `tkem/cachetools`.
4.  **Last-Used Context Persistence and Deferred Task Selection (`store.ts`)**: Persists the active context in `localStorage` (`ax-central.context`) and adds `store.showTask(name)` so newly created or migrated tasks can be selected in Activity immediately or on the next poll.

## The Problem

Developers prototyping AX tasks face four operational gaps today:

1.  **No Live Workspace Migration Across Substrates or Atespaces**: AX checkpoints only a task's `/workspace` volume inside the storage backend of the cluster that created it. Moving a task from a local Apple `container` microVM (`local`) to a Kubernetes cluster (`kind-*` or GKE), or promoting a task from `default` to `staging` on the same stack, requires manually copying YAML manifests, stripping server-populated fields (`status`, `metadata.createTime`), starting both tasks, and manually copying modified files out of `/workspace`.
2.  **`docker-shim.sh` Drops `--metadata-file`**: Newer `docker buildx build --push --metadata-file <path>` invocations pass `--metadata-file` through to `podman build`, which either rejects the flag or leaves `<path>` empty instead of writing the pushed `containerimage.digest` JSON.
3.  **Stale `ax-images` Digests and Schema in Deploy**: `frontend/src/model/designer.ts` uses pre-v0.5.0 `ghcr.io/rakyll/ax-images` digests, lacks the `antigravity` agent preset, and emits `agent: "agent_..."` as a scalar string for `claude-managed-agents` instead of the v0.5.0 object schema (`agent: { model, system }`).
4.  **Context Reset on App Relaunch**: `frontend/src/model/store.ts` persists `ax-central.section` and `ax-central.settings` in `localStorage`, but does not persist the selected `context`, resetting to the default context on every launch.

## Goals

*   Enable moving any task with `spec.debug: true` across atespaces (`default` -> `staging` on `local`) or across contexts (`local` <-> `kind-*`) in 6 tracked steps, preserving all runtime files inside `/workspace`.
*   Normalize un-digested local container images (such as `debian:12` or `ax-agent-local:latest`) when migrating from `local` to a Kubernetes context so Agent Substrate does not reject the destination `ActorTemplate` with `TemplateCreationFailed`.
*   Expose task migration both in the Activity UI (`<ax-move-task-modal>`) and as a consequential WebMCP tool (`move_task`).
*   Support `--metadata-file <path>` and `--metadata-file=<path>` in `docker-shim.sh`.
*   Align `frontend/src/model/designer.ts` with `rakyll/ax-images` v0.5.0 while retaining `gemini`, `openai`, and all `ax-experiments` templates (`ate-local`, `genkit-apple-container`, `swarm-reviewer`).
*   Persist `ax-central.context` in `localStorage` and provide `store.showTask(name)` for deferred task selection.

## Non-Goals

*   Checkpointing or migrating in-memory process state (CRIU); processes restart in the destination sandbox against the migrated `/workspace` filesystem.
*   Removing existing `gemini`, `openai`, or `ax-experiments` templates from `TEMPLATES`.

## Open Questions

*   None. All findings from the EGM Goldfish Review (`egm-codebase-details` and `egm-implementation-readiness`) have been resolved below.

## Critical User Journeys (CUJs)

### CUJ 1: Promote a Task Across Atespaces on the Local Apple Container Stack (`local / default` -> `local / staging`)

*   **Given**: The local Apple `container` stack (`ate-local`) is running on macOS (`localhost:8090`), and task `local-task-01` (with `spec.debug: true`) is in `default` with a runtime-created file `/workspace/report.md`.
*   **When**: The user clicks **Move** (`arrow-right-left` icon) on `local-task-01` in Activity (`⌘1`), keeps **Context** set to `local`, changes **Atespace** to `staging`, leaves **Delete original** unchecked, and clicks **Move**.
*   **Then**: AX Central executes all 6 steps (`Read the task and its workspace` -> `Create it in local / staging` -> `Start both copies` -> `Copy /workspace` -> `Restart the new copy on the copied files` -> `Suspend the original`), displays **Show in local / staging**, switches the active atespace to `staging`, and `/workspace/report.md` is present inside `ate-staging-local-task-01`.

### CUJ 2: Migrate a Local MicroVM Task to a Kubernetes `kind` Cluster (`local` -> `kind-ax-e2e`)

*   **Given**: Task `local-task-01` runs on `local` with `spec.image: "debian:12"` (an un-digested tag that Kubernetes Agent Substrate rejects).
*   **When**: The user opens **Move** on `local-task-01` and selects destination context `kind-ax-e2e`.
*   **Then**: The modal detects that `debian:12` is not pinned by `@sha256:` and enables **Use destination default runner image** (`clearUnpinnedImage: true` by default when moving to a non-`local` context). On **Move**, `portable()` omits `spec.image` on the destination manifest so `kind-ax-e2e` provisions the task using its configured `AX_DEFAULT_TASK_IMAGE`, pipes `/workspace` over `ax ssh` from `.ax-local/bin/ax --server localhost:8090` to `.tmp/bin/ax --context kind-ax-e2e` (with `KUBECONFIG=.tmp/kubeconfig-ax-e2e`), and restarts the destination task.

## Technical Plan (Architecture)

```text
[Source Sandbox (e.g. local / default)]          [Destination Sandbox (e.g. local / staging or kind-*)]
  ax <fromScope> ssh <task>                        ax <toScope> ssh <task>
    -- tar cf - -C /workspace .                      -- sh -c 'chmod -R u+w "$1" 2>/dev/null || true;
              │                                                exec tar xf - -C "$1"' sh /workspace
              │                                                    ▲
              └──────────────► Go Shell.Pipe (os.Pipe) ────────────┘
                        (distinct FromProgram/FromEnv & ToProgram/ToEnv,
                         peer process kill on early exit)
```

### Key Design Decisions (Goldfish-Verified)

1.  **Race-Free, Leak-Free Dual-Environment `PipeRequest` in `shell.go`**:
    *   `PipeRequest` supports optional `FromProgram`, `FromEnv`, `ToProgram`, and `ToEnv` overrides (falling back to `Program` when unset).
    *   In `shell.go`, `Pipe` creates `pr, pw, err := os.Pipe()`, starts `fromCmd` and immediately closes the parent's `pw` copy, then starts `toCmd` (killing and reaping `fromCmd` if `toCmd.Start()` fails) and immediately closes the parent's `pr` copy.
    *   Only after both commands have started does `Pipe` spawn the `fromCmd.Wait()` goroutine (preventing any data race on `toCmd.Process` under `go test -race`). If `fromCmd` exits non-zero, the goroutine kills `toCmd.Process`; if `toCmd.Wait()` returns non-zero first, the parent kills `fromCmd.Process` before reading `<-fromDone`.
2.  **Cross-Substrate Image Normalization in `portable()` (`move.ts`)**:
    *   When moving a task to `to.context !== "local"` and `doc.spec?.image` does not contain `"@sha256:"`, if `to.clearUnpinnedImage ?? true` is true, `portable()` deletes `doc.spec.image` so the destination cluster uses its `AX_DEFAULT_TASK_IMAGE` instead of failing with `TemplateCreationFailed`.
3.  **Single-Pass `stdin` Permission Safety for `tar`**:
    *   Never chain `tar xf - || tar xf -` over a non-seekable `stdin` pipe (if the first `tar` consumes any bytes before failing, the second `tar` reads a corrupted stream). Instead, Step 4 runs `sh -c 'chmod -R u+w "$1" 2>/dev/null || true; exec tar xf - -C "$1"' sh <path>` on the destination so read-only `.git/objects/pack/*.idx` files are made writable before `tar xf -` reads `stdin`.

## Alternatives Considered

### Alternative A: Copy `/workspace` via a Host Temporary Tarball (`mktemp`)

*   **Pros**: Uses two sequential `Shell.Run` calls instead of a concurrent pipe.
*   **Cons**: Buffers potentially hundreds of megabytes of workspace files onto host disk and doubles transfer latency.
*   **Reason for Rejection**: Rejected by author: direct `os.Pipe()` streaming between the two `ax ssh` child processes in `shell.go` is binary-safe, uses zero host disk space, and streams in a single pass.

### Alternative B: Chaining `tar xf - --overwrite || tar xf -` on the Destination

*   **Pros**: Attempts GNU `--overwrite` first.
*   **Cons**: Consumes bytes from the non-seekable `stdin` pipe before failing on BusyBox `tar`, corrupting the stream for the fallback `tar`.
*   **Reason for Rejection**: Rejected after EGM Goldfish review: running `chmod -R u+w "$1" 2>/dev/null || true; exec tar xf - -C "$1"` prepares permissions before `tar` reads `stdin` and works on both GNU and BusyBox `tar`.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security & Privacy (`mcp-auditor`)**:
    *   All `context`, `atespace`, and `task` identifiers in `move.ts` and the `move_task` WebMCP tool must be validated with `isSafeResourceName()` / `reqSafeName()` before spawning `ax` or `Pipe`.
    *   The workspace `path` passed to `tar -C` must be validated by `isSafeWorkspacePath(p)` (`/^\/[a-zA-Z0-9._/-]*$/` and `!p.includes("..")`), and passed as a positional argument (`sh <path>`), never interpolated into a shell string.
*   **Accessibility (`axe-core` WCAG 2.1 AA)**:
    *   `<ax-move-task-modal>` must use `role="dialog" aria-label="Move task"` and explicit `<label for="move-context">` and `<label for="move-atespace">` associations so `axe-core` passes in both light and dark themes.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Phasing & Checkpoints

*   **Phase 1 (Backend & Shim — `ax-central-n0a.2` & `ax-central-n0a.1` Go layer)**: Modify `shell.go`, `app.go`, `docker-shim.sh`, and `shell_test.go`.
    *   *Checkpoint*: `go vet . && GOOS=linux GOARCH=amd64 go vet . && GOOS=windows GOARCH=amd64 go vet . && go test -race -count=1 . && bash -n docker-shim.sh`
*   **Phase 2 (Frontend Models & Presets — `ax-central-n0a.3` & `ax-central-n0a.4` & `move.ts`)**: Modify `frontend/src/bridge.ts`, `frontend/src/icons.ts`, `frontend/src/model/store.ts`, `frontend/src/model/designer.ts`, and create `frontend/src/model/move.ts`.
    *   *Checkpoint*: `cd frontend && npm run build`
*   **Phase 3 (Views, WebMCP Tool, Tests & Live Smoke — `ax-central-n0a.1` & `ax-central-n0a.5`)**: Modify `frontend/src/views/designer-view.ts`, `frontend/src/views/overview-view.ts`, `frontend/src/tools.ts`, `frontend/src/views.test.ts`, and `hack/smoke-local.sh`.
    *   *Checkpoint*: `make check && make smoke-local`

### Target Files to Create/Modify

#### 1. `shell.go` (Modify)

*   **Type / Scope**: Go Subprocess Runner
*   **Proposed Changes**:
    *   Add `PipeRequest` struct and `func (s *Shell) Pipe(req PipeRequest) CommandResult`:
        ```go
        type PipeRequest struct {
        	Program     string            `json:"program"`
        	FromProgram string            `json:"fromProgram,omitempty"`
        	From        []string          `json:"from"`
        	FromEnv     map[string]string `json:"fromEnv,omitempty"`
        	ToProgram   string            `json:"toProgram,omitempty"`
        	To          []string          `json:"to"`
        	ToEnv       map[string]string `json:"toEnv,omitempty"`
        }

        func (s *Shell) Pipe(req PipeRequest) CommandResult {
        	fromName := req.FromProgram
        	if fromName == "" {
        		fromName = req.Program
        	}
        	toName := req.ToProgram
        	if toName == "" {
        		toName = req.Program
        	}
        	fromProg := s.Which(fromName)
        	if fromProg == "" {
        		fromProg = fromName
        	}
        	toProg := s.Which(toName)
        	if toProg == "" {
        		toProg = toName
        	}

        	pr, pw, err := os.Pipe()
        	if err != nil {
        		return CommandResult{Status: 1, Stderr: err.Error()}
        	}

        	fromCmd := exec.Command(fromProg, req.From...)
        	fromCmd.Env = s.mergeEnv(req.FromEnv)
        	fromCmd.Stdout = pw
        	var fromStderr bytes.Buffer
        	fromCmd.Stderr = &fromStderr

        	toCmd := exec.Command(toProg, req.To...)
        	toCmd.Env = s.mergeEnv(req.ToEnv)
        	toCmd.Stdin = pr
        	var stdout, toStderr bytes.Buffer
        	toCmd.Stdout = &stdout
        	toCmd.Stderr = &toStderr

        	if err := fromCmd.Start(); err != nil {
        		_ = pr.Close()
        		_ = pw.Close()
        		return CommandResult{Status: 127, Stderr: fmt.Sprintf("%s: %v", fromName, err)}
        	}
        	_ = pw.Close()

        	if err := toCmd.Start(); err != nil {
        		_ = pr.Close()
        		_ = fromCmd.Process.Kill()
        		_ = fromCmd.Wait()
        		return CommandResult{Status: 127, Stderr: fmt.Sprintf("%s: %v", toName, err)}
        	}
        	_ = pr.Close()

        	fromDone := make(chan error, 1)
        	go func() {
        		err := fromCmd.Wait()
        		if err != nil {
        			_ = toCmd.Process.Kill()
        		}
        		fromDone <- err
        	}()

        	toErr := toCmd.Wait()
        	if toErr != nil {
        		_ = fromCmd.Process.Kill()
        	}
        	fromErr := <-fromDone

        	status := 0
        	for _, e := range []error{fromErr, toErr} {
        		if e != nil && status == 0 {
        			if exitErr, ok := e.(*exec.ExitError); ok {
        				status = exitErr.ExitCode()
        				if status <= 0 {
        					status = 1
        				}
        			} else {
        				status = 1
        			}
        		}
        	}
        	stderr := strings.TrimSpace(fromStderr.String() + "\n" + toStderr.String())
        	return CommandResult{
        		Status: status,
        		Stdout: stdout.String(),
        		Stderr: stderr,
        	}
        }
        ```

#### 2. `app.go` (Modify)

*   **Type / Scope**: Wails Bound Go App
*   **Proposed Changes**:
    *   Add bound method `func (a *App) Pipe(req PipeRequest) CommandResult { return a.shell.Pipe(req) }`.

#### 3. `docker-shim.sh` (Modify)

*   **Type / Scope**: Embedded POSIX Shell Script
*   **Proposed Changes**:
    *   In `buildx_build()`, initialize `plat= tag= push= meta=`, parse `--metadata-file=*) meta=${a#--metadata-file=} ;;` and `--metadata-file) meta=$1; shift; n=$((n - 1)) ;;`.
    *   Replace `exec podman manifest push ...` with:
        ```sh
        f=$(digestfile "$tag")
        podman manifest push --all $(tls "$tag") --digestfile "$f" "$tag" "docker://$tag" || exit
        [ -z "$meta" ] || printf '{"image.name":"%s","containerimage.digest":"%s"}\n' "$tag" "$(cat "$f")" > "$meta"
        ```

#### 4. `shell_test.go` (Modify)

*   **Type / Scope**: Go Unit Tests
*   **Proposed Changes**:
    *   Add `TestShellPipe(t *testing.T)` testing: (a) piping `printf "hello"` into `tr "a-z" "A-Z"` (`"HELLO"`), and (b) non-zero exit propagation when either `from` or `to` fails, using canonical `go-readability` failure messages (`sh.Pipe(%+v) = %+v, want ...`).
    *   Add `TestDockerShimBuildxMetadataFile(t *testing.T)` creating a fake executable `podman` script in `t.TempDir()` (which writes `"sha256:deadbeef"` to the `--digestfile` target on `manifest push` and exits `0`), running `docker-shim.sh buildx build --push --metadata-file <metaFile> -t localhost:5001/app:v1 .` with `PATH` and `XDG_CACHE_HOME` isolated to `t.TempDir()`, and asserting `<metaFile>` equals `{"image.name":"localhost:5001/app:v1","containerimage.digest":"sha256:deadbeef"}\n`.

#### 5. `frontend/src/bridge.ts` (Modify)

*   **Type / Scope**: TypeScript Wails/Mock Bridge
*   **Proposed Changes**:
    *   Export `PipeRequest`:
        ```ts
        export interface PipeRequest {
          program?: string;
          fromProgram?: string;
          from: string[];
          fromEnv?: Record<string, string>;
          toProgram?: string;
          to: string[];
          toEnv?: Record<string, string>;
        }
        ```
    *   Add `pipe(req: PipeRequest): Promise<CommandResult>` to `StudioAPI`, `WailsAppBindings` (`Pipe(req: PipeRequest): Promise<CommandResult>`), `createWailsStudio` (`pipe: (req) => goApp.Pipe(req)`), and `createFallbackStudio` (`pipe: async () => ({ status: 0, stdout: "", stderr: "" })`).

#### 6. `frontend/src/icons.ts` (Modify)

*   **Type / Scope**: Inline SVG Icons
*   **Proposed Changes**:
    *   Add `"arrow-right-left"` to `export type IconName` and add to `switch (name)` in `pathsFor(name: IconName)`:
        ```ts
        case "arrow-right-left":
          return svg`<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>`;
        ```

#### 7. `frontend/src/model/store.ts` (Modify)

*   **Type / Scope**: Reactive Application Store
*   **Proposed Changes**:
    *   Add `const CONTEXT_KEY = "ax-central.context"`.
    *   In `setScope(patch)`: if `patch.context` is non-empty, call `localStorage.setItem(CONTEXT_KEY, patch.context)`.
    *   In `loadContexts()`: read `const saved = localStorage.getItem(CONTEXT_KEY)` and `const last = contexts.find((c) => c.name === saved)?.name`, setting `context: this.state.context || asked || last || defaultCtx`.
    *   Add `axPathFor(context: string): string`, `scopeFor(context: string, atespace: string): string[]`, `envFor(context: string): Record<string, string> | undefined`, and `showTask(name: string | null): void`:
        ```ts
        showTask(name: string | null): void {
          this.askedTask = name;
          this.askedTerminal = false;
          this.set(this.takeAskedTask(this.state.tasks));
          this.setSection("overview");
        }
        ```

#### 8. `frontend/src/model/move.ts` (Create)

*   **Type / Scope**: Task Migration Engine
*   **Proposed Changes**:
    *   Export `MoveTarget`, `StepState`, `MoveStep`, `isSafeWorkspacePath`, `portable`, `moveSteps`, and `moveTask`:
        *   `moveSteps(to: MoveTarget, deleteOriginal: boolean, path = "/workspace"): MoveStep[]` returns the 6 steps:
            1. `"Read the task and its workspace"`
            2. `` `Create it in ${to.context || "local"} / ${to.atespace || "default"}` ``
            3. `"Start both copies"`
            4. `` `Copy ${path}` ``
            5. `"Restart the new copy on the copied files"`
            6. `deleteOriginal ? "Delete the original" : "Suspend the original"`
        *   `portable(text: string, to: MoveTarget): string` parses YAML, deletes `doc.status`, deletes `doc.metadata.{createTime,uid,resourceVersion,generation,managedFields}`, sets `doc.metadata.atespace = to.atespace || "default"`, and if `doc.kind === "Task" && to.context !== "local" && (to.clearUnpinnedImage ?? true) && typeof doc.spec?.image === "string" && !doc.spec.image.includes("@sha256:")`, deletes `doc.spec.image`.
        *   Step 4 invokes `window.studio.pipe` with:
            *   `fromProgram: store.axPathFor(fromContext)`, `fromEnv: store.envFor(fromContext)`, `from: [...fromScope, "ssh", t.name, "--", "tar", "cf", "-", "-C", path, "."]`
            *   `toProgram: store.axPathFor(to.context)`, `toEnv: store.envFor(to.context)`, `to: [...destScope, "ssh", t.name, "--", "sh", "-c", 'chmod -R u+w "$1" 2>/dev/null || true; exec tar xf - -C "$1"', "sh", path]`

#### 9. `frontend/src/model/designer.ts` (Modify)

*   **Type / Scope**: Deploy Designer Model & Presets
*   **Proposed Changes**:
    *   Add `"antigravity"` to `export type Template` and `TEMPLATES` (`{ id: "antigravity", title: "Antigravity Agent", group: "ax-images" }`).
    *   Update `IMAGE_DIGESTS`:
        ```ts
        const IMAGE_DIGESTS = {
          antigravity:
            "sha256:8025a987861673718564e0e648a3c7785d23c2514be8c7a3d3b133413d9bc81e",
          gemini:
            "sha256:e3d8d953fc1ca112e3b0d00a655d82008996a328a5e8dbd1777f68f492fb91bc",
          openai:
            "sha256:9eeeb86183c1514ca4e3da8f412c2f704a457be13ba9797ebb1d942ba89417c1",
          "claude-managed-agents":
            "sha256:1a532d86c58a5fea3005e9c525683cf8f354e2c403be6460a308ad2f8f0510c0",
          "github-actions":
            "sha256:63d02f8ff154efd5ee269414bc793bde90afb5aadedbe756e1c2f8389207c7bd",
        };
        ```
    *   In `agentTask()`, set `wsName: \`cachetools-${name}\``, `repo: "https://github.com/tkem/cachetools.git"`, `branch: "master"`, and `AGENTS.md` install line ``- Pure-Python library. Install with \`pip install -e . pytest\`, test with \`pytest\`.``.
    *   In `templateDraft(t: Template)`:
        *   Add `case "antigravity":` returning `agentTask(d, "antigravity", AGENT_PROMPT + "model: gemini-3.8-flash\nmaxTurns: 100\nbuiltinTools: [\"google_search\", \"url_context\"]\n", ["GEMINI_API_KEY"])`.
        *   Update `case "claude-managed-agents":` to use:
            ```yaml
            environment: "env_..."
            agent:
              model: "claude-opus-5-5"
              system: "You are a careful software engineer working in /workspace."
            ```
            followed by `+ AGENT_PROMPT` and `["ANTHROPIC_API_KEY", "ANTHROPIC_ENVIRONMENT_KEY"]`.

#### 10. `frontend/src/views/designer-view.ts` (Modify)

*   **Type / Scope**: Deploy View
*   **Proposed Changes**:
    *   In `viewCreatedInActivity()`, call `store.showTask(this.createdTaskName)`.

#### 11. `frontend/src/views/overview-view.ts` (Modify)

*   **Type / Scope**: Activity View, Task Inspector & `<ax-move-task-modal>`
*   **Proposed Changes**:
    *   Update `actionsForTask(t: AXTask, onDelete: () => void, onMove?: () => void): TaskAction[]` to insert `{ label: "Move…", iconName: "arrow-right-left", run: onMove }` when `onMove` is provided, and pass `() => (this.movingTask = t)` at all 3 call sites (`AxTaskInspector.render`, `AxOverview.render` table row, and `AxOverview.render` context menu).
    *   Define `@customElement("ax-move-task-modal") export class AxMoveTaskModal extends LitElement` with `<label for="move-context">`, `<label for="move-atespace">`, a toggle for `clearUnpinnedImage` (when moving an unpinned image to a non-`local` context), a toggle for `deleteOriginal`, the 6-step progress list, and `Show in ${shortName(this.context)}`.

#### 12. `frontend/src/tools.ts` (Modify)

*   **Type / Scope**: WebMCP Tools
*   **Proposed Changes**:
    *   Add `"move_task"` to `TOOL_GROUPS.Tasks` and `TOOLS` (`consequential: true`, parameters: `name` (required), `target_context` (optional, defaults to active context), `target_atespace` (optional, defaults to active atespace), `delete_original` (optional boolean)).
    *   Update `load_template` description to include `antigravity`.

#### 13. `frontend/src/views.test.ts` (Modify)

*   **Type / Scope**: Vitest Browser & Accessibility Test Suite
*   **Proposed Changes**:
    *   In `beforeEach`, call `localStorage.clear()` and reset `store.set({ context: "local", atespace: "default", selectedTaskID: null, webmcpOpen: false, settingsOpen: false })`.
    *   Add unit and browser tests for `template("antigravity")`, `template("claude-managed-agents")`, `ax-central.context` persistence (resetting `store.set({ context: "" })` before `await store.loadContexts()`), `store.showTask()`, `<ax-move-task-modal>`, and WebMCP `move_task`.

#### 14. `hack/smoke-local.sh` (Modify)

*   **Type / Scope**: Live Apple Container E2E Smoke Script
*   **Proposed Changes**:
    *   Extend `hack/smoke-local.sh` to write `/workspace/migrated-proof.txt` in `atespace: default`, migrate the task and `/workspace` via `tar cf - | tar xf -` over `ax ssh` to `atespace: staging`, assert `cat /workspace/migrated-proof.txt` succeeds in `staging`, and clean up both `default` and `staging` tasks on exit.

### Verification Plan

*   **Compilation/Build**: `make build`
*   **Unit & Browser Tests**: `make test` (`go test -race -count=1 .` + `cd frontend && npm test`)
*   **Static Analysis & Security**: `make check` (`make lint && make security && make test`)
*   **Live E2E Verification**: `make smoke-local`

--------------------------------------------------------------------------------

*Drafted and Reviewed with EGM*
