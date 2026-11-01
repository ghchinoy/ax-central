# Tutorial: Run Your First Local Task in AX Central

This tutorial walks through booting the local Apple `container` (`ate-local`) stack on macOS, deploying a `debian:12` task with a workspace, streaming guest logs, opening an interactive `ax ssh` shell, and calling AX tools through the WebMCP Inspector. The entire walkthrough runs locally in under two minutes and requires no cloud credentials or API keys.

## Step 1: Audit Prerequisites and Launch AX Central

From the `ax-central` repository root, run the prerequisite doctor:

```bash
make doctor
```

On an Apple Silicon Mac configured for the local stack, `hack/doctor.sh` reports `ok` across the five Tier-A checks:

```text
  [✓] Go toolchain                     go1.25.5 (/usr/local/go/bin/go)
  [✓] Apple container runtime          /usr/local/bin/container (daemon running)
  [✓] AX repo (ate-local variant)      /Users/you/projects/ax (branch: feat/ate-local-apple-container)
  [✓] ate-local & arm64 task runner    /Users/you/projects/ax/.ax-local/bin ready
  [✓] ax-experiments & agent image     /Users/you/projects/ax-experiments + ax-agent-local:latest
```

If any check reports a warning, run `make bootstrap` to clone the required branches and build `.ax-local/bin/{ax,ate-local,ax-server}` and `.ax-local/bin/linux_arm64/ax-task-runner`.

You can verify the headless stack from your terminal at any time with:

```bash
make smoke-local
```

Next, build and open the native macOS application bundle (or run `make dev` for a live-reloading Wails development session):

```bash
make wails-build && open "build/bin/AX Central.app"
```

> **Window controls:** Grab any empty area on the top toolbar or the top-left sidebar header to drag the window. Double-click the empty toolbar to toggle window zoom.

---

## Step 2: Start the Local Stack in Clusters (`⌘5`)

1. Click **Clusters** in the left sidebar (or press **`⌘5`**).
2. Inspect the **Environment & Prerequisites Doctor** card at the top of the page. If any dependency needs repair, click **Bootstrap All** (or the individual **Fix** button) to stream the build in the bottom console.
3. Locate the **Apple Container (`ate-local`)** stack card:
   * If the status badge reads **Stopped**, click **Start**.
   * The bottom **Output** console opens and streams `examples/ate_local/local-stack.sh up`.
   * In about 3.3 seconds, all three layers report green (**Ready**):
     * **AX** (`ax-server` listening on `127.0.0.1:8090`)
     * **ate-local Substrate** (`ate-local` gRPC server listening on `127.0.0.1:50051`)
     * **Apple Container** (`ax-local-postgres` on `127.0.0.1:5432` and active `ate-*` microVMs)
4. Click **Open in Central** on the card. AX Central sets the active context in the top toolbar to **`local`** and routes `ax` CLI commands to `localhost:8090` using `<repoPath>/.ax-local/bin/ax`.

---

## Step 3: Compose and Create a Task in Deploy (`⌘3`)

1. Click **Deploy** in the sidebar (or press **`⌘3`**).
2. Open the **Templates** dropdown in the top-right header. AX Central groups templates into three categories:
   * **Built-in**: `Blank`, `Shell`
   * **`ax-images`**: `Gemini Agent`, `OpenAI Agent`, `Claude Agent`, `GitHub Actions Runner`
   * **`ax-experiments`**: `Apple Container (ate-local)`, `Genkit Triage Agent (Apple Container)`, `Swarm Code Reviewer (04-review-panel)`
3. Choose **`Apple Container (ate-local)`**:
   * In the **Task** section on the left, set **Command** to:
     ```sh
     sh -c 'echo "Hello from microVM: $(uname -sm)" && sleep 300'
     ```
   * In the **Workspace** section, select **New**, keep the workspace name `my-workspace`, and click **Add file** to attach an inline `AGENTS.md` file.
   * Watch the **Composition Diagram** (top-right) render the animated `/workspace` connector between `Workspace` and `Task`, while the **Generated YAML** pane (bottom-right) updates its multi-document manifest.
   * Toggle **Edit raw** in the YAML header to inspect the raw manifest editor with its synchronized line-number gutter, then toggle back to the visual editor.
4. Click **Create** (or press **`⌘↩`**). The footer status bar confirms `task.ax.io/local-task-... created`.

---

## Step 4: Resume the Task and Stream Logs in Activity (`⌘1`)

1. Click **Activity** in the sidebar (or press **`⌘1`**).
2. Locate your new `local-task-...` entry in the **Tasks** table. New tasks in AX start in the **`Suspended`** phase.
3. Click the **Play (`▶` Resume)** button on the task row (or right-click the row and select **Resume**):
   * `ate-local` boots an isolated Linux `arm64` microVM (`ate-default-local-task-...`) on the macOS `vmnet` bridge (`192.168.64.x`) in roughly 0.7 seconds.
   * Once `/readyz` responds on port `80`, the task phase badge transitions to **`Running`**.
4. Click the task row to open the slide-in **Task Inspector** on the right:
   * **Lifecycle bar**: `Created`, `Workspace`, and `Ready` light up green.
   * **Sandbox fields**: Displays `Image: debian:12`, `Workspace: my-workspace -> /workspace`, `Worker IP: 192.168.64.x`, `Actor`, and `Debug: on`.
   * **Logs (`<ax-task-logs>`)**: Streams live container output via `container logs -f ate-default-local-task-...`. Click the maximize icon in the logs footer to open the full-screen log modal, and press `Esc` to close it.

---

## Step 5: Explore the Resource Graph in Map (`⌘2`)

1. Click **Map** in the sidebar (or press **`⌘2`**).
2. The SVG Bezier graph illustrates how repository, file, and MCP server sources feed into `my-workspace`, and how `my-workspace` mounts into `local-task-...`.
3. Use the zoom controls (`+`, `-`, `100%`) in the top-right corner of the canvas, or click any task card in the graph to inspect it.

---

## Step 6: Open an Interactive Shell in Terminal (`⌘4`)

1. Click **Terminal** in the sidebar (or press **`⌘4`**), or click the **Terminal** action button inside the Task Inspector.
2. In the left **Tasks in default** list, click your running `local-task-...` task.
3. `<ax-terminal-session>` opens an interactive `ax ssh` session directly to the microVM (`192.168.64.x:80`):
   * Run `uname -a`, `ip addr`, or `ls -la /workspace` inside the terminal.
   * Click **New session** to open a second parallel tab to the same task.
   * Click **Open in Ghostty** to launch a native `/Applications/Ghostty.app` window connected to the task over `ax ssh`, or click **Copy ax ssh** to copy the standalone terminal command.

---

## Step 7: Call AX Tools via WebMCP (`⌘I`)

1. Click the **`WebMCP: in-app registry`** (or **`WebMCP: document.modelContext`**) badge in the top toolbar (or press **`⌘I`**).
2. The **WebMCP Inspector** drawer opens on the right:
   * **Tools tab**: Lists all 17 registered tools across **Tasks**, **Workspaces & Scope**, and **Deploy & Clusters** (`list_tasks`, `get_task`, `select_task`, `suspend_task`, `resume_task`, `delete_task`, `list_workspaces`, `delete_workspace`, `list_contexts`, `switch_scope`, `load_template`, `get_draft_manifest`, `apply_manifest`, `list_clusters`, `manage_local_stack`, `check_prerequisites`).
   * **Run tab**: Select `list_tasks` or `check_prerequisites` and click **Call** to execute the tool and inspect its JSON output and latency in the **Calls** log.
3. When you finish testing, suspend or delete the task from **Activity** (or via `delete_task` in WebMCP), and click **Stop** on the Apple Container card in **Clusters** (`⌘5`) to shut down the local stack.
