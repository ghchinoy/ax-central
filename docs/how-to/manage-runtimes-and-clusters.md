# How-To: Manage Runtimes, Prerequisites, and Clusters

This guide shows how to audit and bootstrap host dependencies with `hack/doctor.sh`, manage both local Apple `container` (`ate-local`) stacks and Kubernetes `kind` clusters, use the Podman `docker-shim.sh` adapter, and switch contexts in AX Central.

## 1. Audit and Bootstrap Prerequisites

AX Central supports two local compute substrates:
* **Tier A (Apple `container` / `ate-local`)**: Runs tasks as isolated Linux `arm64` microVMs on the macOS `vmnet` bridge (`192.168.64.x`) in ~3.3 seconds without Kubernetes.
* **Tier B (Kubernetes / `kind`)**: Runs the full Kubernetes Agent Substrate control plane and `gVisor` worker pool inside a local `kind` cluster.

### Run the Prerequisite Auditor from the CLI

```bash
# Human-readable audit report
make doctor

# Machine-readable JSON report (used by the in-app Prerequisite Doctor and WebMCP)
bash hack/doctor.sh --json
```

### Bootstrap Missing Dependencies or Variants

To repair all missing Tier-A dependencies in one command:

```bash
make bootstrap
```

You can also target individual components with `hack/doctor.sh --install <target>`:

| Target | Action Performed by `hack/doctor.sh` |
| :--- | :--- |
| `wails` | Installs Wails CLI `v2.17.1` (`go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1`) and, on Linux/Crostini, `libgtk-3-dev` + `libwebkit2gtk-4.1-dev`. |
| `container-daemon` | Runs `container system start` to boot the macOS Apple `container` service. |
| `ax-repo` | Clones `ghchinoy/ax` (or fetches branch `feat/ate-local-apple-container` into `~/projects/ax`) so `cmd/ate-local` and `examples/ate_local/local-stack.sh` are present. |
| `ate-local-bins` | Compiles `.ax-local/bin/{ax,ate-local,ax-server}` and cross-compiles `.ax-local/bin/linux_arm64/ax-task-runner`. |
| `ax-experiments` | Clones `ghchinoy/ax-experiments` into `~/projects/ax-experiments`. |
| `agent-image` | Builds `ax-agent-local:latest` (`linux/arm64`) via `container build` from `~/projects/ax-experiments/swarm/agent-image`. |
| `all` | Runs each of the targets above that is not yet satisfied. |

---

## 2. Manage the Apple `container` (`ate-local`) Stack

In **Clusters** (`⌘5`), the **Apple Container (`ate-local`)** card monitors three health layers:
1. **AX Control Plane**: `ax-server` on `127.0.0.1:8090`.
2. **ate-local Substrate**: `ate-local` gRPC `ControlServer` on `127.0.0.1:50051`.
3. **Apple Container & PostgreSQL**: `ax-local-postgres` (`postgres:17-alpine` on `127.0.0.1:5432`) and active `ate-*` microVMs on `vmnet`.

### Lifecycle Controls
* **Start / Restart Stack**: Executes `bash examples/ate_local/local-stack.sh up` inside `<repoPath>`, streaming build and startup logs to the bottom **Output** console.
* **Stop**: Executes `bash examples/ate_local/local-stack.sh down`, stopping `ax-server`, `ate-local`, and `ax-local-postgres`.
* **Reset**: Executes `bash examples/ate_local/local-stack.sh reset`, tearing down all `ate-*` actor containers and recreating a clean PostgreSQL store.
* **Open in Central**: Switches the active context in `store.ts` to `local`.

---

## 3. Create and Manage `kind` Clusters (Docker or Podman)

When `kind`, `kubectl`, and either `docker` or `podman` are installed, the **New cluster** card in **Clusters** (`⌘5`) provisions a full local Kubernetes E2E cluster via `hack/setup-e2e-kind.sh`:

1. Enter a cluster **Name** (for example, `ax-dev`) and choose the number of `gVisor` **Workers** (`1` to `8`).
2. Optionally specify a **Substrate** git ref (defaults to the `go.ate.dev/substrate` version in `<repoPath>/go.mod`).
3. Click **Create cluster**. AX Central tracks progress across four stages:
   * `Kind cluster` $\rightarrow$ `Agent Substrate` $\rightarrow$ `Worker pool` $\rightarrow$ `AX control plane`.
4. When creation finishes, AX Central merges `kind-<name>` into `~/.kube/config` without altering your global default context. Click **Open in Central** on the cluster card to target it. AX Central also auto-discovers clusters provisioned via `hack/setup-e2e-kind.sh` or `~/projects/ax-experiments/crostini/setup-crostini.sh` (`<repoPath>/.tmp/kubeconfig-<name>`) and caches Agent Substrate images in `~/.cache/substrate-registry`.

### Using Podman Without Docker Desktop (`docker-shim.sh`)

On machines where `podman` is installed without `docker`, `shell.go` writes the embedded `docker-shim.sh` script to `~/Library/Application Support/ax-central/bin/docker` and prepends it to `PATH` with `KIND_EXPERIMENTAL_PROVIDER=podman`. The shim handles three Podman-specific differences required by `hack/setup-e2e-kind.sh` and Agent Substrate:
1. Appends `--tls-verify=false` when pushing or pulling against `localhost:5001` or `127.0.0.1:*` local registries.
2. Emulates `docker buildx build --push` (including `--metadata-file` JSON output) and `docker buildx imagetools inspect` using `podman build`, `podman manifest push --digestfile`, and `podman manifest inspect`.
3. Caches pushed manifest digests across Podman layer recompression so `docker inspect --format='{{index .RepoDigests 0}}'` returns the exact registry digest required by Kubernetes pods.

> **Podman memory requirement:** Building Agent Substrate with `ko` inside a Podman VM requires at least 6 GiB of memory. If `clusters.ts` detects a Podman machine with less than 6144 MiB, it displays a warning with the exact resize command:
> ```bash
> podman machine stop && podman machine set --memory 8192 && podman machine start
> ```

---

## 4. Configure Paths and Switch Scopes

1. Click the **Settings** gear icon in the top-right toolbar (or press **`⌘,`**).
2. Configure:
   * **`ax` binary**: Path or command name for the `ax` CLI (defaults to `ax`; `store.ts` automatically prefers `<repoPath>/.ax-local/bin/ax` when targeting `local` and `<repoPath>/.tmp/bin/ax` or `<repoPath>/bin/ax` when targeting Kubernetes clusters).
   * **AX repository**: Path to your `ax` checkout (defaults to `~/projects/ax`).
   * **AX Experiments**: Path to your `ax-experiments` checkout (defaults to `~/projects/ax-experiments`).
   * **Local `AX_SERVER`**: Address of the local `ax-server` (defaults to `localhost:8090`).
   * **Refresh**: Polling interval in seconds (`2s` to `30s`).
   * **Prerequisite Doctor**: Shortcut button in the Settings modal footer that opens the Clusters Doctor card.
3. Use the **Context** dropdown and **Atespace** input in the top toolbar to switch between `local` and `kind-*` contexts or between atespaces (`default`, `staging`, etc.) without mutating your shell's global configuration. AX Central persists your last-selected context in `localStorage` (`ax-central.context`).
