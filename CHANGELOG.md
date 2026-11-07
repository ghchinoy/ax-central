# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Common Changelog](https://common-changelog.org/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0](https://github.com/ghchinoy/ax-central/compare/v0.1.0...v0.2.0) (2026-11-07)


### Features

* **crostini:** auto-discover Kind .tmp/kubeconfig-* & ax binaries and add live Crostini E2E smoke test (ax_central-l85) ([c590bc4](https://github.com/ghchinoy/ax-central/commit/c590bc4c480820d96423e9f25189624aaf11b05c))

## [0.1.0] - 2026-11-01

_Initial release._

### Added
- **Desktop Control Plane:** Wails v2 + Lit 3 WebComponents (`<ax-central>`) macOS desktop shell with Luminous 0.15–0.19 light and dark design tokens, WCAG 2.1 AA accessibility verified by `axe-core`, and BiDi prose token isolation.
- **Apple Container (`ate-local`) Stack Management:** First-class 3-layer health probe (`ax-server :8090`, `ate-local :50051`, `ax-local-postgres :5432` + active `ate-*` microVMs on `vmnet` `192.168.64.x`) and streaming `Start` / `Stop` / `Reset` lifecycle controls in `<ax-clusters>` (`[ax-central-was.1]`).
- **Deploy Designer & `ax-experiments` Templates:** Split-pane visual task designer (`<ax-designer>`) with live SVG Composition Diagram, `.env` paste parser, STDIO MCP (`command` + `args`) and `skills.path` workspace generation, and built-in templates for `ate-local`, `genkit-apple-container`, and `swarm-reviewer` (`[ax-central-was.2]`).
- **Standalone Prerequisite Doctor & Bootstrap (`hack/doctor.sh`):** CLI and in-app Environment Doctor (`make doctor`, `make bootstrap`) that audits and installs `go`, `/usr/local/bin/container`, `~/projects/ax` (`feat/ate-local-apple-container`), `.ax-local/bin/{ax,ate-local,ax-server,linux_arm64/ax-task-runner}`, `~/projects/ax-experiments`, `ax-agent-local:latest`, and `kind`/`kubectl`/`docker`/`podman` (`[ax-central-mhe]`).
- **Live Guest Log Streaming (`<ax-task-logs>`):** Real-time log streaming in the Activity Task Inspector for both local Apple `container` microVMs (`container logs -f ate-<atespace>-<actor>`) and Kubernetes worker pools (`kubectl logs -l ate.dev/worker-pool`), plus a `make smoke-local` E2E verification script (`[ax-central-dso]`, `[ax-central-ojo]`).
- **Interactive Terminal (`<ax-terminal>`):** Multi-tab `ax ssh` sessions built on the `TerminalBackend` interface with `script(1)` PTY negotiation, `AXS-LINE-MODE` fallback, and one-click external launch in `/Applications/Ghostty.app`.
- **WebMCP Integration (`document.modelContext`):** `ToolHost` registry and `<ax-webmcp-drawer>` exposing 16 AX tools across `Tasks`, `Workspaces & Scope`, and `Deploy & Clusters`, including `manage_local_stack` and `check_prerequisites` (`[ax-central-was.3]`).
- **Documentation, Luminous Diagrams & Screenshots:** Four-quadrant Diátaxis documentation under `docs/`, semantic Luminous Graphviz diagrams (`make diagrams`), automated retina light/dark WebP screenshot generator (`make screenshots`), and `release-please` macOS release packaging (`make release-darwin`) (`[ax-central-iyy]`, `[ax-central-yr8]`).

### Fixed
- **Designer YAML Alignment:** Unified line-number gutter, padding, and scroll synchronization between read-only YAML preview and raw YAML edit mode while preventing Prettier template whitespace injection inside `.yaml-line` (`[ax-central-zkx]`).
- **macOS Window Dragging in Shadow DOM:** Added capture-phase `mousedown` reflection of `--wails-draggable: drag | no-drag` onto the `<ax-central>` shadow host so grabbing the titlebar or sidebar header smoothly drags the native Wails window (`[ax-central-nip]`).

### Security
- **WebMCP Argument-Injection & STDIO MCP Guards:** Enforced `reqSafeName` validation across all WebMCP tool inputs to reject leading `-` CLI flags, added `mcp-auditor` warnings for shell wrappers in Workspace STDIO MCP servers, and added `make security` (`npm audit` + Go readability checks) (`[ax-central-hw9]`).

[0.1.0]: https://github.com/ghchinoy/ax-central/releases/tag/v0.1.0
