# Quality & Security Gates Directive (`go-readability`, `mcp-auditor`, `node-security-audit`)

This directive defines the code quality, readability, and security gates derived from `~/projects/agent-skills` and enforced by `make check` (`make lint && make security && make test`).

## 1. Go Readability (`~/projects/agent-skills/plugins/go-readability`)
- **Formatting & Linting**:
  - Format all Go files with `gofmt -s -w .` and `goimports`.
  - Run `go vet .` and `golangci-lint run .` (`.golangci.yml` v2).
- **Canonical Test Failure Messages (`decisions#useful-test-failures`)**:
  - Every test failure in `*_test.go` must be diagnosable without reading the test source:
    `YourFunc(<inputs>) = <got>, want <want>`
  - Always identify the function name and its inputs, and use `%q` for strings so empty strings and control characters are visible.
- **Modern Go Idioms**:
  - Use `any` instead of `interface{}` (enforced by `make security`).
  - Use `t.Context()` in tests when a `context.Context` is needed.
  - Keep receiver names to 1–2 letters (`a *App`, `s *Shell`) applied consistently across methods.
  - Avoid `Get*` prefixes on getters; use `var s []T` over `s := []T{}` when nil slices suffice.

## 2. WebMCP & Subprocess Security (`~/projects/agent-skills/plugins/mcp-security`)
- **CLI Argument-Injection Guard (`mcp-auditor` §2)**:
  - Even when spawning subprocesses without a shell (`exec.Command` in `shell.go`), arguments originating from WebMCP tool calls (`document.modelContext`) must never start with `-` (e.g., `name: "--help"` or `name: "-f"`), which `ax` or `kubectl` would interpret as CLI flags.
  - All resource/context/atespace identifiers in `frontend/src/tools.ts` must be validated with `reqSafeName(args, key)` (`/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/`, no leading `-`).
- **Workspace STDIO MCP Audit (`mcp-auditor` §1)**:
  - `issues(d: Draft)` in `frontend/src/model/designer.ts` warns whenever a Workspace STDIO MCP server configuration includes shell-wrapper flags (`sh -c`, `bash -c`, `npx -c`) or shell metacharacters (`|`, `;`, `&`, `` ` ``, `$`).

## 3. Node & Supply-Chain Security (`~/projects/agent-skills/plugins/repo-authoring/skills/node-security-audit`)
- **Runtime Floor**: `frontend/package.json` enforces `"engines": { "node": ">=22.23.4" }`.
- **Dependency Audit**: `make security` runs `npm audit --audit-level=moderate` inside `frontend/` and verifies zero moderate/high/critical vulnerabilities.
- **Shell Script Syntax Gate**: `make lint` validates all shell scripts with `bash -n hack/*.sh docker-shim.sh`.
- **Version Lockstep (`release-please`)**: `var appVersion` (`app.go`), `info.productVersion` (`wails.json`), `version` (`frontend/package.json`), and `.release-please-manifest.json` must remain synchronized, with `-ldflags "-s -w -X main.appVersion=$(VERSION)"` injected during `make build` / `make release-darwin`.
