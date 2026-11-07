# Reference: CLI, Shortcuts, and WebMCP Tools

This reference documents AX Central's `Makefile` targets, `hack/doctor.sh` CLI flags and JSON output schema, keyboard shortcuts, and all 16 WebMCP tools registered in `frontend/src/tools.ts`.

## 1. `Makefile` Targets

| Target | Command / Behavior |
| :--- | :--- |
| `make check` | Runs all quality gates in sequence: `make lint`, `make security`, and `make test`. |
| `make build` | Builds the Vite frontend (`frontend/dist`) and compiles the `ax-central` Go binary with `-ldflags "-s -w -X main.appVersion=$(VERSION)"`. |
| `make wails-build` | Packages the native macOS bundle at `build/bin/AX Central.app`. |
| `make release-darwin` | Builds `AX Central.app`, archives `dist/AX-Central-v$(VERSION)-darwin-arm64.zip`, and writes `dist/SHA256SUMS`. |
| `make version` | Prints the current version from `wails.json` (`info.productVersion`). |
| `make dev` | Starts a live-reloading `wails dev` session. |
| `make run-frontend` | Starts the standalone Vite dev server (uses `createFallbackStudio()`). |
| `make test` | Runs Go race tests (`go test -race -count=1 .`) and frontend Vitest browser tests (`Playwright Chromium` + `axe-core` WCAG 2.1 AA). |
| `make lint` | Runs `gofmt -s`, `go vet .`, `golangci-lint run .`, `bash -n hack/*.sh docker-shim.sh`, `tsc --noEmit`, and `prettier --check .`. |
| `make security` | Runs `npm audit --audit-level=moderate` and verifies Go files use `any` instead of `interface{}`. |
| `make doctor` | Runs `bash hack/doctor.sh` to audit Tier-A (`ate-local`) and Tier-B (`kind`) prerequisites. |
| `make bootstrap` | Runs `bash hack/doctor.sh --install all` to clone/build missing Tier-A prerequisites. |
| `make smoke-local` | Runs `bash hack/smoke-local.sh` to verify a live `debian:12` task lifecycle on the local Apple `container` stack. |
| `make smoke-crostini` | Runs `bash hack/smoke-crostini.sh` to verify a live Workspace + Task lifecycle (`apply`, `resume`, `ax ssh`, `suspend`) on a local `kind` + Agent Substrate (`gVisor`) cluster. |
| `make diagrams` | Renders `docs/diagrams/*.dot` to `*-{light,dark}.webp` via `gvpr` (`../graphviz-style/theme/luminous.gvpr`) and `dot -Twebp`. |
| `make screenshots` | Runs `node hack/screenshots.mjs` to capture `1440×900` (`2x`) light and dark WebP screenshots in `docs/screenshots/`. |
| `make format` | Formats Go (`gofmt -s -w .`) and frontend TypeScript/CSS (`prettier --write .`). |
| `make clean` | Removes `ax-central`, `build/bin`, `dist`, and `frontend/dist`. |

---

## 2. `hack/doctor.sh` CLI and JSON Schema

```bash
hack/doctor.sh [--json] [--install [all|container-daemon|ax-repo|ate-local-bins|ax-experiments|agent-image]]
```

### Environment Variables
* `AX_REPO`: Path to the `ax` repository checkout (default: `~/projects/ax`).
* `AX_EXPERIMENTS_REPO`: Path to the `ax-experiments` checkout (default: `~/projects/ax-experiments`).

### `--json` Output Schema
```json
{
  "axRepo": "/Users/you/projects/ax",
  "experimentsRepo": "/Users/you/projects/ax-experiments",
  "checks": [
    {
      "id": "go | apple-container | ax-repo-variant | ate-local-bins | ax-experiments | kind-stack",
      "tier": "core | ate-local | kind",
      "title": "Human-readable check title",
      "status": "ok | warn | fail",
      "detail": "Detected binary path, version, or branch",
      "fix": "Suggested repair command when status != ok"
    }
  ]
}
```

---

## 3. macOS Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `⌘1` | Switch to **Activity** (`<ax-overview>`) |
| `⌘2` | Switch to **Map** (`<ax-topology>`) |
| `⌘3` | Switch to **Deploy** (`<ax-designer>`) |
| `⌘4` | Switch to **Terminal** (`<ax-terminal>`) |
| `⌘5` | Switch to **Clusters** (`<ax-clusters>`) |
| `⌘R` | Refresh active context tasks, workspaces, and models |
| `⌘I` | Toggle **WebMCP Inspector** drawer (`<ax-webmcp-drawer>`) |
| `⌘,` | Open **Settings** modal |
| `⌘N` | Load blank task design in **Deploy** |
| `⌘O` | Open YAML manifest from disk into **Deploy** |
| `⌘S` | Save current YAML manifest from **Deploy** to disk |
| `⌘↩` | Apply (`ax apply -f -`) the current manifest in **Deploy** |
| `Esc` | Close open dropdown menu or collapse full-screen task logs modal |

---

## 4. WebMCP Tools Catalog (`document.modelContext`)

All resource, context, and atespace names passed to WebMCP tools are validated by `reqSafeName` (`/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/`, rejecting leading `-` flags).

### Group 1: `Tasks`

| Tool Name | Flags | Parameters | Description |
| :--- | :--- | :--- | :--- |
| `list_tasks` | `readOnly`, `untrusted` | `{}` | Lists all tasks in the current context and atespace with `id`, `name`, `atespace`, `phase`, `workspace`, `image`, `worker_ip`, `age`, and `selected`. |
| `get_task` | `readOnly`, `untrusted` | `{ name: string }` | Returns full details, conditions, resources, and raw YAML manifest for a task by name. |
| `select_task` | *(none)* | `{ name: string }` | Selects a task in the UI to open `<ax-task-inspector>` (pass `""` to close). |
| `suspend_task` | `consequential` | `{ name: string }` | Suspends a running or pending task (`ax suspend task <name>`). |
| `resume_task` | *(none)* | `{ name: string }` | Resumes a suspended, failed, or completed task (`ax resume task <name>`). |
| `delete_task` | `consequential` | `{ name: string }` | Deletes a task and tears down its sandbox (`ax delete task <name>`). |

### Group 2: `Workspaces & Scope`

| Tool Name | Flags | Parameters | Description |
| :--- | :--- | :--- | :--- |
| `list_workspaces` | `readOnly`, `untrusted` | `{}` | Lists all workspaces in the current atespace with `repos`, `mcp_servers`, `files`, and dependent `tasks`. |
| `delete_workspace` | `consequential` | `{ name: string }` | Deletes a workspace from the current atespace (`ax delete workspace <name>`). |
| `list_contexts` | `readOnly` | `{}` | Lists available AX / Kubernetes contexts, the active `current_context`, `atespace`, and UI `section`. |
| `switch_scope` | *(none)* | `{ context?: string, atespace?: string, section?: "overview" \| "topology" \| "designer" \| "terminal" \| "clusters" }` | Switches AX Central to a different context, atespace, or UI section. |

### Group 3: `Deploy & Clusters`

| Tool Name | Flags | Parameters | Description |
| :--- | :--- | :--- | :--- |
| `load_template` | *(none)* | `{ template: "blank" \| "simple" \| "gemini" \| "openai" \| "claude-managed-agents" \| "github-actions" \| "ate-local" \| "genkit-apple-container" \| "swarm-reviewer" }` | Loads a task template into `<ax-designer>` and switches to the **Deploy** view. |
| `get_draft_manifest` | `readOnly` | `{}` | Returns the current YAML manifest in `<ax-designer>` (with secrets redacted), `can_apply`, and validation `issues`. |
| `apply_manifest` | `consequential` | `{ yaml?: string }` | Applies either the provided `yaml` string or the current `<ax-designer>` draft via `ax apply -f -`. |
| `list_clusters` | `readOnly` | `{}` | Returns container runtime info, `ate_local` 3-layer stack health and microVM list, and `kind` `clusters`. |
| `manage_local_stack` | `consequential` | `{ action: "up" \| "down" \| "reset" \| "status" }` | Starts, stops, resets, or queries the local Apple `container` (`ate-local`) stack via `examples/ate_local/local-stack.sh`. |
| `check_prerequisites` | `readOnly` | `{}` | Runs `hack/doctor.sh --json` to audit `go`, `/usr/local/bin/container`, `~/projects/ax` (`feat/ate-local-apple-container`), `.ax-local/bin/*`, `~/projects/ax-experiments`, `ax-agent-local:latest`, and `kind`/`kubectl`/`docker`/`podman`. |
