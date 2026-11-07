# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Common Changelog](https://common-changelog.org/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-06

### Added
- **Multi-Layer Task Log Filters (`<ax-task-logs>`):** Added `All`, `Guest`, `Substrate`, and `OTel` segmented filter controls (plus a `runsc` toggle for low-level gVisor boot logs) so operators can inspect container output alongside Substrate actor lifecycle, RPC, and checkpoint events (`[ax_central-qbp.2]`).
- **Live Sandbox Telemetry Strip:** `<ax-task-logs>` extracts real-time cgroup memory working set and peak MiB, CPU time, RustFS volume snapshot checkpoint latency, and captured OpenTelemetry trace counts from Substrate worker records (`[ax_central-qbp.2]`).
- **Interactive OpenTelemetry Trace Waterfall (`<ax-task-logs>` & `<ax-task-inspector>`):** Log lines carrying an OpenTelemetry `trace_id` render a compact inline `trace:<shortId>` badge that opens an inline span waterfall merging in-sandbox Genkit spans (`genkit otel span`) with in-cluster Jaeger v2 distributed traces (`otel-system/deploy/jaeger` `/api/v3/traces/<id>`) across `ateapi`, `atelet`, and `ateworker-gvisor` (`[ax_central-qbp.1]`, `[ax_central-qbp.3]`).
- **Linux WebKit2GTK 4.1 Auto-Configuration & Crostini Walkthrough:** `Makefile` and `hack/doctor.sh` (`--install wails`) detect Debian 13 (`trixie`) `webkit2gtk-4.1` and pass `-tags webkit2_41` automatically during `make dev`, `make build`, and `make wails-build`, accompanied by Walkthrough B in `docs/tutorials/quickstart-local-stack.md` (`[ax_central-xkx]`, `[ax_central-7bg]`).

### Fixed
- **Compact Inline Trace Badges:** Styled `.trace-pill` with `white-space: nowrap`, `height: 15px`, and `line-height: 1` so inline trace badges do not inherit multi-line `pre-wrap` expansion from `.task-log-line` (`[ax_central-qbp.3]`).

## [0.2.0] - 2026-11-06

### Added
- **Chromebook / Crostini & Kind (`v1.0.0-rc.1`) Auto-Discovery:** `store.ts` and `shell.go` automatically discover `~/projects/ax/.tmp/bin/ax`, `~/projects/ax/bin/ax`, and running `kind-*` clusters with `~/projects/ax/.tmp/kubeconfig-<cluster>` without requiring manual `kind export kubeconfig`, and propagate `KUBECONFIG` across `ax` commands, `<ax-task-logs>` streams, and interactive `<ax-terminal>` (`ax ssh`) sessions (`[ax_central-l85.1]`, `[ax_central-l85.2]`).
- **Live Crostini E2E Smoke Suite (`make smoke-crostini`):** Added `hack/smoke-crostini.sh` and `TestLiveCrostiniKindClusterE2E` in `shell_test.go` to verify Workspace and Task creation, `gVisor` (`runsc`) sandbox resume, `ax ssh` interactive execution over `atenet-router` mTLS, and RustFS snapshot suspend on `kind-ax-e2e` (`[ax_central-l85.4]`).
- **OS-Aware Prerequisite Doctor & Substrate Image Caching:** `hack/doctor.sh` and `clusters.ts` detect Linux/Crostini environments (`hack/setup-e2e-kind.sh` and `crostini/setup-crostini.sh`), and `clusters.ts` sets `SUBSTRATE_IMAGE_CACHE_DIR` during cluster provisioning to reuse cached Agent Substrate images (`[ax_central-l85.3]`).
- **Bulk Task Lifecycle Actions & 3-OS Release Matrix:** Added `Resume All (N)` and `Suspend All (N)` bulk controls in `<ax-overview>`, cross-OS process-group helpers (`proc_unix.go`, `proc_windows.go`), and 3-OS GitHub Actions release builds (`darwin-universal`, `linux-amd64`, `windows-amd64`) (`[ax-central-4dd]`).

### Changed
- **Toolchain & Dependency Refresh:** Upgraded Go to `1.26.0`, `github.com/wailsapp/wails/v2` to `v2.17.1`, `typescript` to `~7.0.2`, `@xterm/xterm` to `^6.0.0`, `@xterm/addon-fit` to `^0.11.0`, `yaml` to `^2.9.1`, `vite` to `^8.3.6`, `vitest` and `@vitest/browser-playwright` to `^5.1.0`, and `playwright` to `^1.65.0` (`[ax_central-fqz.3]`).
- **Session Process Groups & Bounded Tool Log:** Interactive sessions in `shell.go` now run in dedicated process groups terminated cleanly on `CloseSession()`, and `<ax-central>` caps `toolLog` history to 200 entries (`[ax_central-fqz.4]`).

### Fixed
- **Cross-Platform Headless Chromium Discovery:** `frontend/vitest.config.ts` and `hack/screenshots.mjs` now discover Playwright's headless Chromium cache across both macOS (`~/Library/Caches/ms-playwright`) and Linux (`~/.cache/ms-playwright`) (`[ax_central-fqz.4]`).
- **Guest Log Actor Matching on Agent Substrate 1.0:** `<ax-task-logs>` matches guest container log records by `ate.actor.name` (`t.name` or `t.actor`) and `ate.template.name` (`${t.name}-tmpl-*`) and styles `runsc` glog lines (`[ax_central-l85.2]`).

### Security
- **Shell & CLI Boundary Hardening:** Replaced double-quoted `t.phase` interpolation in `<ax-task-logs>` with single-quoted `printf` arguments, enforced `NAME_RE` and shell-quoted temporary kubeconfig paths in `clusters.ts`, and validated resource/context identifiers with `isSafeResourceName()` in `store.ts` before invoking `ax` (`[ax_central-fqz.1]`).
- **User-Scoped Runtime Directories & Webview CSP:** Moved `Shell.KubeconfigFor()` files and `docker-shim.sh` buildx digests out of shared `/tmp` into `0700` user-scoped directories, added a `<meta http-equiv="Content-Security-Policy">` policy to `frontend/index.html`, and added path-traversal containment to `hack/screenshots.mjs` (`[ax_central-fqz.2]`).

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

[0.3.0]: https://github.com/ghchinoy/ax-central/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ghchinoy/ax-central/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ghchinoy/ax-central/releases/tag/v0.1.0
