# AX Central vs. AX Studio (`agentexecutor/studio`): Positioning & Strategic Direction

The upstream AX team graduated AX Studio into its own public repository at **[`github.com/agentexecutor/studio`](https://github.com/agentexecutor/studio)** (bundled into `google/ax` releases via `ax studio`). In [`agentexecutor/studio#28`](https://github.com/agentexecutor/studio/pull/28) (*"Focus Studio on AX on this computer: setup first, no remote clusters or Changes"*), Studio deliberately narrowed its scope to a **single-computer, single-Kind-cluster** local UI.

At the same time, upstream [`google/ax#732`](https://github.com/google/ax/pull/732) and [`google/ax#756`](https://github.com/google/ax/pull/756) established that **AX is a pure declarative control plane** (zero data-plane polling, no `TaskOutcome` / `Completed` / `Failed` fields), leaving **external orchestration, multi-task coordination, outcomes, steering, and trajectory observability** to tools layered *above* AX.

This document records a code-level comparison between `agentexecutor/studio` (`v0.4.0-rc.1`, `a632e9e`) and **AX Central** (`v0.6.1`) and sets AX Central's forward direction so we stop duplicating Studio's Day-0 single-cluster scope and double down on non-overlapping strengths.

---

## 1. Architecture & Stack Comparison

| Dimension | `agentexecutor/studio` (`ax studio`) | **AX Central** (`~/projects/ax-central`) |
| :--- | :--- | :--- |
| **Form factor** | Single Go HTTP binary (`cmd/ax-studio`, opens browser on `127.0.0.1:8080`); Electron packaging tracked in `#6` | Native desktop app for macOS, Linux, and Windows (Wails v2 + Go + Lit 3 WebComponents) |
| **Frontend** | Zero-build vanilla JS/CSS (`ux/*.js`, vendored `xterm.js`, embedded via `go:embed`) | TypeScript + Lit 3 + Vite + `@xterm/xterm`, WCAG 2.1 AA verified with `axe-core` |
| **AX API transport** | Direct gRPC via `github.com/google/ax/client` (`internal/studio/dial.go`), sharing CLI port-forwards; `ax` CLI for `apply`/`local`/`ssh` | Shells out to `ax` CLI (`shell.go`); migrating reads/writes to `github.com/google/ax/client` is tracked in `ax-central-ipb` |
| **Terminal** | Real PTY (`creack/pty`) over SSE + HTTP (`internal/studio/terminal.go`), multi-tab `xterm.js` | Real PTY (`creack/pty`) over Wails bridge (`shell.go`), multi-tab `@xterm/xterm` |
| **Local runtime support** | **Kind only** (`--context ax-local`); requires Docker or rootful Podman + Linux kernel $\ge 6.8$ | **Multi-substrate**: standalone [`substrate-local`](https://github.com/ghchinoy/substrate-local) (Apple `container` & rootless Podman, ~2 s startup), Kind (`docker-shim.sh`), Crostini, and remote Kubernetes |
| **Upstream AX alignment** | `v0.4.0-rc.1` (tracking `v0.4.0-rc.2` updates in `#34`, `#36`, `#37`) | `v0.4.0-rc.2` + `8d879b5` (`#731` `TaskState`, `#756` no `TaskOutcome`, `#678` release default, `#763` `agy-cli`) |

---

## 2. Feature Overlap vs. Exclusive Differentiators

| Capability | `agentexecutor/studio` | **AX Central** | Strategic Call |
| :--- | :---: | :---: | :--- |
| **Single-cluster local Kind setup (`ax local start/stop/delete`)** | Yes (Setup page, `ax local status -o json`) | Yes (Kind + Podman `docker-shim.sh`) | **100% overlap** — let Studio own Kind Day-0 onboarding |
| **Basic CRUD (Tasks, Workspaces, Gateways, Models), Logs, PTY `ax ssh`** | Yes (native gRPC) | Yes | **100% overlap** — maintain compatibility, don't chase cosmetic parity |
| **New Task form + side-by-side YAML + presets** | Yes (`Antigravity`, `Claude Code`, `Blank`) | Yes (`<ax-designer>`, 8+ templates, live OCI `@sha256` resolver) | **Overlap on basic form**; keep AX Central focused on multi-doc swarm/dgem/Genkit templates & OCI digest pinning |
| **K8s Gateway Credential Secrets (stdin-piped, key-names-only probe)** | Yes (`internal/studio/secrets.go`) | Not yet | **Adopt in AX Central** (zero-echo Secret creation for Kind & remote clusters) |
| **Zero-Kubernetes local runtime (`substrate-local` / Apple `container` / rootless Podman)** | No (requires Docker or rootful Podman + Kind) | Yes (~2 s startup, 0 GiB idle VM, dual-cluster A/B, Doctor) | **Exclusive to AX Central** — migrate to standalone `~/projects/substrate-local` |
| **Multi-cluster & non-Kind kubeconfig contexts (GKE, OrbStack, Colima, Crostini, Tailscale) + `ax install` preflight** | No (**removed in `#28`**; locked to `--context ax-local`) | Yes (`00k.1` discovery + `00k.2` `ax install`/`uninstall` preflight) | **Exclusive to AX Central** |
| **Stateful cross-cluster `Move Task` (`/workspace` `tar` over dual `ax ssh` + `@sha256` pinning)** | No (and `google/ax#694` closed as *won't fix*) | Yes (`move.ts`, verified live in `make smoke-local`) | **Exclusive to AX Central** |
| **Multi-agent Swarm Topology Map, DVR replay & OTel Trace Waterfall** | No | Yes (`<ax-topology>`, DVR scrubber, OTel waterfall in `<ax-task-logs>`) | **Exclusive to AX Central** |
| **Interactive A2A Wake & Prompt + Inline `dgem` HITL Approval** | No | Yes (built-in A2A console + inline HITL approve/deny) | **Exclusive to AX Central** |
| **WebMCP (`document.modelContext`, 24 AX tools) + Multi-Registry Image Catalog** | No (directs agents to `ax` CLI; read-only cookie API) | Yes (24 WebMCP tools + `ghchinoy`, `agentexecutor`, `rakyll`, custom registries) | **Exclusive to AX Central** |

---

## 3. When to Use Which Tool

- **Use AX Studio (`ax studio`)** when you want the official, zero-setup browser UI for a **single local Kind cluster** (`ax-local`) installed by `google/ax`'s installer.
- **Use AX Central** when you need:
  - **2-second zero-Kubernetes macOS/Podman development** backed by [`substrate-local`](https://github.com/ghchinoy/substrate-local);
  - **Multi-cluster operations** across laptop (`substrate-local` / Kind / Crostini) and remote clusters (GKE, OrbStack, Tailscale), including **`ax install` preflight** and **stateful `Move Task`**;
  - **Multi-agent orchestration & observability**: Topology Map, Session DVR, OTel trace waterfalls, A2A Wake & Prompt, inline `dgem` HITL approvals, or **WebMCP** programmatic control.

---

## 4. Forward Direction for AX Central

1. **Decouple from the `ghchinoy/ax` fork via `~/projects/substrate-local`**: Point `ClustersStore` and `hack/doctor.sh` at standalone `~/projects/substrate-local` (`scripts/ax-stack.sh`) running **unmodified upstream `google/ax`** binaries, keeping fallback detection for `~/projects/ax/examples/ate_local` during transition.
2. **Adopt two high-leverage patterns from `agentexecutor/studio`**:
   - Direct gRPC via `github.com/google/ax/client` in `app.go` (tracked in `ax-central-ipb`).
   - Stdin-piped Kubernetes Gateway Credential Secret management (reading key names only, never echoing secret values).
3. **Invest UI effort exclusively in the External Orchestrator & Multi-Cluster layer (`google/ax#756`)**:
   - `ForkTask` (`#669`) + `status.parentTask` lineage edges in Topology (`<ax-topology>`).
   - `TaskService` (`#692`) steering + trajectory waterfalls (`#724` Pillar #7) + `dgem` HITL gates.
   - Stateful cross-cluster `Move Task` and multi-cluster `ax install` / Substrate onboarding (`ax-central-00k.3`).
