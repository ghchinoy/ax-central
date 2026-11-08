# EGM Documentation Drift Report (`v0.3.0`)

*   **Date:** 2026-11-07
*   **Skill:** `egm-drift-report` (`~/projects/elephant-goldfish-model/skills/egm-drift-report/SKILL.md`)

## `README.md`

*   **Prerequisite versions (`README.md:121` vs. `go.mod:3`, `hack/doctor.sh:79`):** Lists `Go 1.25+ and Wails CLI v2.13+`, whereas the codebase uses Go `1.26+` and `hack/doctor.sh --install wails` installs Wails CLI `v2.17.1`.
*   **Release archive version in comment (`README.md:152`):** Shows `dist/AX-Central-v0.1.0-darwin-arm64.zip` instead of `dist/AX-Central-v0.3.0-darwin-arm64.zip`.
*   **Missing `v0.2.0`/`v0.3.0` Activity & `<ax-task-logs>` capabilities (`README.md:91`):** Omits `Resume All (N)` / `Suspend All (N)` bulk actions, multi-layer log filters (`All`, `Guest`, `Substrate`, `OTel`, `runsc`), the Live Sandbox Telemetry Strip (cgroup RAM/CPU, RustFS checkpoint latency, trace count), and the inline OpenTelemetry + Jaeger v2 trace waterfall (`trace:<shortId>`).
*   **Template & Doctor button labels (`README.md:66,163`):** Quickstart step 2 says `Apple Container (ate-local)` instead of `Apple Container Task (ate-local)`; Troubleshooting says `Click Fix` instead of `Click Repair`.

## `docs/index.md`

*   **Missing `v0.3.0` observability summary (`docs/index.md:18,37`):** Tutorial and Explanation descriptions omit the multi-layer Substrate/OTel log filters, sandbox cgroup/checkpoint telemetry strip, and Jaeger v2 + Genkit OpenTelemetry trace waterfall.

## `docs/tutorials/quickstart-local-stack.md`

*   **`make doctor` sample output (`docs/tutorials/quickstart-local-stack.md:22-30`):** Shows 5 checks with `Go toolchain go1.25.5`, whereas `hack/doctor.sh` outputs 6 checks starting with `[✓] Go & Wails toolchain` (`go1.26.x + wails`).
*   **UI label drift (`docs/tutorials/quickstart-local-stack.md:52,72-77,104,210`):** Refers to `Fix` instead of `Repair`, old `ax-experiments` template titles instead of `Apple Container Task (ate-local)` / `Genkit Incident Triage (ate-local)` / `Swarm Code Reviewer (ate-local)`, and `Logs` instead of `Logs & Telemetry` (with `All`/`Guest`/`Substrate`/`OTel` filters, telemetry strip, and OTel trace waterfall).

## `docs/how-to/manage-runtimes-and-clusters.md`

*   **Missing `wails` bootstrap target (`docs/how-to/manage-runtimes-and-clusters.md:29-38`):** Omits `wails` from the `hack/doctor.sh --install <target>` table.
*   **Settings modal fields & binary auto-discovery (`docs/how-to/manage-runtimes-and-clusters.md:83-88`):** Omits the `Local AX_SERVER` (`localServer`) setting, the `Prerequisite Doctor` button in the Settings modal footer, and `store.effectiveAxPath` auto-discovery of `<repoPath>/.tmp/bin/ax` and `<repoPath>/bin/ax`.

## `docs/how-to/design-tasks-and-use-webmcp.md`

*   **Template titles & Model card (`docs/how-to/design-tasks-and-use-webmcp.md:22-42`):** Uses pre-v0.2.0 `ax-experiments` template titles, omits `tools/incident_mcp.py` from the `genkit-apple-container` inline file list, and says Deploy has five cards (omitting the 6th card, `Model`).

## `docs/reference/cli-and-webmcp-tools.md`

*   **`Makefile` and `hack/doctor.sh` reference (`docs/reference/cli-and-webmcp-tools.md:10-33`):** Omits `make smoke-crostini`, `$(WAILS_TAGS)` auto-detection on Linux, cross-OS `GOOS=linux` / `GOOS=windows` `go vet` in `make lint`, and `wails` in `hack/doctor.sh --install`.
*   **WebMCP `manage_local_stack` enum (`docs/reference/cli-and-webmcp-tools.md:112`):** Omits `"use"` from `{ action: "status" | "up" | "down" | "reset" | "use" }`.

## `docs/explanation/architecture.md`

*   **Process-group & observability architecture (`docs/explanation/architecture.md:15-36`):** Omits `proc_unix.go` (`SIGINT` + `SIGTERM` + 100ms `SIGKILL`) and `proc_windows.go` (`taskkill /T /F /PID`), session process-group isolation on `StartSession`/`CloseSession`, Kind `.tmp/kubeconfig-*` auto-discovery, and the v0.3.0 multi-layer telemetry + Jaeger v2 trace waterfall architecture.
