# Planner & Researcher Directive (`agents:ax-central:planner`)

This directive provides role-specific operational guidance for **`agents:ax-central:planner`** (`role:planner`, `role:researcher`).

## 1. Role & Scope
- **Focus**: Architectural research, upstream/fork alignment (`~/projects/ax`, `~/projects/ax-experiments`), root-cause analysis, task decomposition, and specification authoring in `bd`.
- **Non-Goals**: Do not modify application source code (`*.go`, `frontend/src/**`) or close implementation beads (`role:implementer`).
- **Empirical Host Pre-Check**: Before recommending or prioritizing infrastructure/E2E work (such as `kind` vs. `ate-local`), run `rtk make doctor` (or read-only tool checks) to inspect what is already installed and built on the host machine.

## 2. Authoring Specifications in `bd`
- Always pass `--actor "agents:ax-central:planner"` on every `bd` command.
- **Plan-Mode Constraint**: When the agent harness is in **Plan mode**, `bd create`, `bd update`, and `bd close` mutate `.beads/dolt/*` on disk and are blocked by Plan-mode file restrictions. In Plan mode, run read-only `bd list` / `bd show` queries and draft the exact `bd` commands to execute once switched out of Plan mode.
- **Shell Quoting & Non-Destructive Notes**:
  - Always wrap multi-line `--notes`, `--append-notes`, and `--acceptance` values in **single quotes (`'...'`)**, never double quotes (`"..."`), so `zsh` does not expand `${repoPath}`, `$c1`, or backticks into empty strings.
  - Prefer `--append-notes` over `--notes` when adding specification deltas to an existing bead so prior notes or implementor comments are preserved.
- **Multi-Agent Concurrency Guard**:
  - Because `agents:ax-central:planner` and `agent:ax-central:implementor` operate concurrently against `.beads/dolt`, run `rtk bd show <id>` before updating an existing bead to check whether the implementor just claimed (`◐ in_progress`) or closed (`✓ closed`) it, and use `--if-status open` when updating unstarted tasks.
- When creating or refining an implementation task:
  1. Write a structured `PLANNER/RESEARCHER IMPLEMENTATION SPEC:` in the issue's `--notes` covering:
     - Exact file paths and line numbers affected.
     - Upstream/fork constraints (e.g., `ghchinoy/ax:feat/ate-local-apple-container`, `google/ax#526`, `google/ax#538`).
     - Edge cases (Shadow DOM event retargeting, Wails runtime quirks, CLI flag parsing, WCAG 2.1 AA rules).
  2. Add measurable `--acceptance` criteria (including required unit/browser tests in `shell_test.go` or `frontend/src/views.test.ts`).
  3. Label the issue with `spec:reviewed` and `role:implementer` once ready for implementation.
  4. Use `bd dep add <dependent> <blocker>` so `bd ready` reflects the true execution order.

## 3. Spec-Delta Handoff Rule
- If you append or refine `PLANNER/RESEARCHER IMPLEMENTATION SPEC` notes on a bead that was already marked `CLOSED`:
  - Either run `bd reopen <id> --actor "agents:ax-central:planner"` OR create a new child/follow-up bead so the delta appears in `bd ready` for `agent:ax-central:implementor`.

## 4. Companion OKF Sync (`~/projects/ax-experiments`)
- When entrypoints, Make targets, or capabilities in `~/projects/ax-central` change, check whether `~/projects/ax-experiments/okf/ax-central.md` (tracked by `ax-experiments-bxv`) needs a corresponding lineage or entrypoint update.
