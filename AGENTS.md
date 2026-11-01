# AGENTS.md — AX Central

A native macOS/desktop control plane for **[AX](https://github.com/google/ax)** and **[Agent Substrate](https://github.com/agent-substrate/substrate)** (`~/projects/ax` and [`~/projects/ax-experiments`](../ax-experiments)): design tasks, watch them run, open interactive terminals over `ax ssh`, manage both local Apple `container` (`ate-local`) stacks and `kind` clusters, and expose AX operations as **WebMCP** (`document.modelContext`) tools.

Built with **Wails v2** (Go) and **Lit 3 WebComponents** (TypeScript, Luminous 0.15–0.19 design tokens).
`CLAUDE.md` and `GEMINI.md` are symlinks to this file.

## Issue Tracking (`bd`)

This project uses **bd (beads)** for issue tracking. Run `bd prime` for full workflow context.

```bash
bd ready                                           # Find unblocked work
bd show <id>                                       # Read full spec & notes before starting
bd create "Title" --type task -p 2 --actor "$BEADS_ACTOR"
bd update <id> --claim --actor "$BEADS_ACTOR"      # Claim work
bd close <id> --actor "$BEADS_ACTOR" --reason="..." # Close after make check passes
```

> **Companion Tracking in `~/projects/ax-experiments`:** AX Central is cataloged as Track 4 (`type: External Experiment`) in `~/projects/ax-experiments/okf/ax-central.md` under epic `ax-experiments-bxv`.

## Progressive Discovery: Role Directives (`.agents/directives/`)

To keep this root file concise, read the directive matching your active role (`$BEADS_ACTOR`) or task before making changes:

| Role / Domain | Actor / Trigger | Directive File |
| :--- | :--- | :--- |
| **Planner & Researcher** | `agents:ax-central:planner` (`role:planner`, `role:researcher`) | [`.agents/directives/planner.md`](.agents/directives/planner.md) |
| **Implementor & Eng Lead** | `agent:ax-central:implementor` (`role:implementer`) | [`.agents/directives/implementor.md`](.agents/directives/implementor.md) |
| **Quality & Security Gates** | All code changes, reviews & pre-close checks (`go-readability`, `mcp-auditor`, `node-security-audit`) | [`.agents/directives/quality-and-security.md`](.agents/directives/quality-and-security.md) |
| **Docs, Diagrams & Visuals** | `README.md`, `CHANGELOG.md`, `docs/**` (Diátaxis), `../graphviz-style`, WebP screenshots | [`.agents/directives/docs-and-visuals.md`](.agents/directives/docs-and-visuals.md) |

<!-- headroom:rtk-instructions -->
## RTK (Rust Token Killer) - Token-Optimized Commands

When running shell commands, **always prefix with `rtk`**. This reduces context usage by 60-90% with zero behavior change.
- In command chains, prefix each segment: `rtk git add . && rtk git commit -m "msg"`
- Use non-interactive flags (`cp -f`, `mv -f`, `rm -f`) so commands never hang on confirmation prompts.
<!-- /headroom:rtk-instructions -->

## Commands & Quality Gates

| Task | Command |
| :--- | :--- |
| **Run all quality gates (lint + security + test)** | **`make check`** |
| Build frontend + Go binary | `make build` |
| Package native macOS `.app` bundle (`build/bin/AX Central.app`) | `make wails-build` |
| Package release zip + `SHA256SUMS` (`dist/`) | `make release-darwin` |
| Live-reload Wails dev session | `make dev` |
| Run all tests (Go `-race` + Vitest Chromium + `axe-core`) | `make test` |
| Lint (`gofmt -s`, `go vet .`, `golangci-lint`, `bash -n`, `tsc`, `prettier`) | `make lint` |
| Security & readability audit (`npm audit`, Go `any` check) | `make security` |
| Audit prerequisites & variants (`hack/doctor.sh`) | `make doctor` |
| Bootstrap/repair prerequisites (`hack/doctor.sh --install`) | `make bootstrap` |
| Live local Apple `container` E2E smoke test (`debian:12`) | `make smoke-local` |
| Format Go + TypeScript/CSS | `make format` |

## Repository Layout

```text
Makefile                        check, build, wails-build, release-darwin, test, lint, security, doctor, bootstrap
.golangci.yml                   golangci-lint v2 configuration (gofmt -s, goimports)
.agents/directives/             Role-specific directives (planner.md, implementor.md, quality-and-security.md, docs-and-visuals.md)
hack/doctor.sh                  Standalone prerequisite auditor (--json) & bootstrap installer (--install)
hack/smoke-local.sh             Live E2E debian:12 task smoke test against local Apple container stack
main.go / app.go / shell.go     Wails v2 native shell, login-shell PATH, process-group streams, ax ssh sessions
docker-shim.sh                  Embedded docker -> podman shim (TLS skip on localhost, buildx digest preservation)
frontend/src/
  theme.css / shared-styles.ts  Luminous 0.15–0.19 light/dark tokens + WCAG AA semantic status colors
  bridge.ts                     StudioAPI interface, Wails runtime adapter, and fallback/mock test bridge
  registry.ts / tools.ts        WebMCP ToolHost (document.modelContext + fallback registry) & 16 AX tools
  model/{resources,store,designer,clusters}.ts  EventTarget reactive stores
  views/{overview,task-logs,topology,designer,terminal,clusters,webmcp-drawer}*.ts
  views.test.ts                 Vitest + Playwright + axe-core WCAG 2 A/AA + E2E flow & security test suite
```
