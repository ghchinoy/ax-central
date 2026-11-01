# AX Central

A native desktop app for [AX](../ax): design tasks, watch them run, open terminals over `ax ssh`, manage local `kind` clusters, and expose AX operations as **WebMCP** (`document.modelContext`) tools.

Built with **Wails v2** (Go) and **Lit 3 WebComponents** (TypeScript, Luminous 0.15–0.19 design tokens).

## Views & Capabilities

- **Activity (`<ax-overview>`):** Atespace digest card with session SVG phase sparkline, sortable task table, workspace table, and slide-in task inspector with streaming Kubernetes guest logs (`<ax-task-logs>`).
- **Map (`<ax-topology>`):** Interactive zoomable SVG Bezier graph showing how Git repos and MCP servers feed workspaces and how workspaces feed tasks.
- **Deploy (`<ax-designer>`):** Split-pane visual form and syntax-highlighted YAML editor with built-in templates (`blank`, `simple`, `gemini`, `openai`, `claude-managed-agents`, `github-actions`) and live composition diagram.
- **Terminal (`<ax-terminal>`):** Persistent `xterm.js` sessions into running tasks over `ax ssh`, supporting both `script(1)` PTY and line-mode shells.
- **Clusters (`<ax-clusters>`):** Create, inspect, and delete local AX clusters on `kind` (`Kind cluster` → `Agent Substrate` → `Worker pool` → `AX control plane`).
- **WebMCP Inspector (`<ax-webmcp-drawer>`):** Registers AX tools (`list_tasks`, `get_task`, `select_task`, `suspend_task`, `resume_task`, `delete_task`, `list_workspaces`, `delete_workspace`, `list_contexts`, `switch_scope`, `load_template`, `get_draft_manifest`, `apply_manifest`, `list_clusters`) with `document.modelContext` (or the in-app fallback registry), with live call logs, group toggles, diagnostics, and a manual tool runner.

## Develop & Test

```sh
make build          # Build frontend (Vite) + Go binary
make wails-build    # Package native macOS .app bundle via Wails v2
make dev            # Live-reloading Wails dev session
make test           # Go tests (-race) + frontend Vitest (Playwright Chromium + axe-core)
make lint           # gofmt, go vet, tsc, prettier
```
