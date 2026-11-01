# Implementor & Engineering Lead Directive (`agent:ax-central:implementor`)

This directive provides role-specific technical and architectural rules for **`agent:ax-central:implementor`** (`role:implementer`).

## 1. Role & Workflow
- Always pass `--actor "agent:ax-central:implementor"` on `bd update --claim`, `bd assign`, `bd comment`, and `bd close`.
- Before implementing a task, read its full `bd show <id>` output—especially the `PLANNER/RESEARCHER IMPLEMENTATION SPEC` notes.
- Use `--append-notes` (or `bd comment`) rather than `--notes` when recording progress on a bead so existing planner specifications are never overwritten.
- Before closing any bead, run `make check` (`make lint && make security && make test`) and include a concise verification summary in `--reason`.

## 2. Go / Wails v2 Backend Rules (`main.go`, `app.go`, `shell.go`)
- **Go Tooling Scope**: Always run `go vet .` and `go test -race -count=1 .` (never `./...`, which recurses into `frontend/node_modules/`).
- **Process Groups (`shell.go`)**: Streamed shell commands (`local-stack.sh`, `setup-e2e-kind.sh`, `kubectl logs -f`, `container logs -f`) run in their own process group (`Setpgid: true` on Unix) so `CancelStream` sends `SIGINT` to `-pid` and stops the entire pipeline.
- **Login Shell `PATH`**: GUI launches on macOS do not inherit the user's shell `PATH`. `buildLoginPath()` queries `$SHELL -ilc` on startup and merges standard tool paths (`~/go/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, etc.).
- **Wails Shadow DOM Window Dragging (`app.ts`)**:
  - Wails v2 inspects `window.getComputedStyle(e.target).getPropertyValue('--wails-draggable')` on a `window` bubble-phase `mousedown` listener.
  - Because `<ax-central>` uses a Shadow DOM root, `e.target` is retargeted to `<ax-central>`. Always reflect `--wails-draggable: drag | no-drag` onto the `<ax-central>` host in a capture-phase `mousedown` listener (`isTitlebarDragTarget(e)`), and clear it on `mouseup`/`blur`.

## 3. Apple `container` (`ate-local`) & `~/projects/ax-experiments` Rules
- **Critical `store.scope` Rule for `local`**:
  - When `store.state.context === 'local'`, `store.scope` MUST return `['--server', localServer, '-a', atespace]` and NEVER `['--context', 'local', ...]`.
  - Passing `--context local` causes `ax` (`internal/tunnel/tunnel.go:EnsureServerURL`) to run `kubectl --context local port-forward` and fail.
  - Including `--server <host:port>` directly in `store.scope` also ensures `<ax-terminal-session>` (`StartSession` and `Copy ax ssh`) targets the local `ax-server` without needing environment variable overrides on `SessionRequest`.
- **Binary Resolution**: When `context === 'local'` and `settings.axPath === 'ax'`, `store.effectiveAxPath` prefers `<repoPath>/.ax-local/bin/ax` when present on disk.
- **Local Container Logs (`views/task-logs.ts`)**:
  - On `context === 'local'`, `<ax-task-logs>` streams `container logs -f` for `ate-<sanitize(atespace)>-<sanitize(actor|name)>` (falling back to `ax.<atespace>.<name>`), parsing both structured JSON log lines and raw guest stdout/stderr.

## 4. Lit 3 & Luminous 0.15–0.19 Styling Rules
- **Prettier & `white-space: pre`**: Never place multi-line Lit `html` expressions directly inside a `white-space: pre` container: Lit preserves template whitespace verbatim. In `<ax-designer>`, `.yaml-line` uses `display: flex` (which ignores inter-element whitespace nodes per CSS Flexbox §4) and applies `white-space: pre` to `.yaml-tok` spans.
- **Atomic Theme Switching for `axe-core`**: Keep CSS transitions on geometric/elevation properties (`transform`, `box-shadow`, `opacity`) rather than `background-color` or `color` on buttons and surfaces so `data-theme="light" ↔ "dark"` switches apply atomically without mid-transition contrast failures in `axe-core`.
- **Keyboard Accessibility**: Every scrollable region without focusable children (`.topo-scroll`, `.yaml-view`) must have `tabindex="0" role="region" aria-label="..."` (`scrollable-region-focusable`).
- **Terminal Backend (`views/terminal-view.ts`)**: `<ax-terminal-session>` interacts exclusively with `TerminalBackend` (`createTerminalBackend()`). When invoking `/Applications/Ghostty.app/Contents/MacOS/ghostty -e`, pass each argument token separately in `args`.
