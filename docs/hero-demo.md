# Walkthrough: Live 5/5 AX v0.1 Hero Demo in AX Central

This walkthrough guides you through running all five steps of the **[AX v0.1 Hero Demo](https://github.com/google/ax/pull/590)** (`5/5 🟢 PASS`) live inside **AX Central** across **Cluster A** (macOS Apple `container` microVMs on `:8090` / `:50051`) and **Cluster B** (Podman containers on `:8091` / `:50052`).

---

## Launch Options

You can run the full 5-step demo from the UI, from the CLI presenter script, or via WebMCP:

```bash
# Option A: One-shot live run attached to AX Central (:8090 / :8091), keeping resources live
make demo-hero

# Option B: Interactive presenter mode (pauses before each step so you can click through AX Central)
bash hack/demo-hero-central.sh --interactive
```

Or inside **AX Central.app**:
* Press **`⌘5`** (**Clusters**) and click **`Run v0.1 Hero Demo (5/5)`** on the **AX v0.1 Hero Demo** card, **or**
* Press **`⌘I`** (**WebMCP Inspector**) and run **`run_hero_demo`** (`{ "attach": true, "keep_stack": true }`).

---

## Step-by-Step Guide Across AX Central Views

### Step 1: Local Up & Studio (`⌘5` Clusters)
* **What runs**: `examples/ate_local/local-stack.sh multi-up` boots **Cluster A** (`ax-server :8090` + `ate-local` Control & embedded `atenet-router :50051` on Apple `container`) and **Cluster B** (`ax-server-b :8091` + `ate-local-b :50052` on Podman), sharing `~/projects/ax/.ax-local/snapshots`.
* **What to inspect in AX Central**:
  * In **Clusters (`⌘5`)**, both the **Apple Container (`ate-local`)** card and the **Podman Cluster B (`ate-local-b`)** card light up green (`Ready`).
  * In the **AX v0.1 Hero Demo** card on the right, `1. Local Up & Studio` transitions to green (`PASS`).
* **WebMCP equivalent**: `manage_local_stack` (`{ "action": "multi-up" }`), `list_clusters`.

---

### Step 2: Warm Workspace Snapshot (`⌘1` Activity $\rightarrow$ Workspaces & Snapshots)
* **What runs**: Applies `hero-demo-ws` (`Workspace.spec.setup.commands` running `git init /workspace/app` and writing `math_utils.py` + `test_math.py`), pre-warms the workspace, checkpoints `/workspace` on suspend, and mints the immutable Agent Substrate v1.0 `Tag` **`hero-demo-ws-warm`** (`SNAPSHOT_STORAGE_STATE_COMPLETED`), verifying warm wake-on-request (`HTTP 200`) through `atenet-router`.
* **What to inspect in AX Central**:
  * Press **`⌘1`** (**Activity**): `hero-demo-ws` appears in the **Workspaces** table.
  * Scroll to **Workspace Snapshots** at the bottom of Activity and click **`Inspect`** on the `.tar.gz` archive to browse `app/math_utils.py` and `app/test_math.py` directly on disk.
* **WebMCP equivalent**: `list_workspaces`.

---

### Step 3: Starter Task, Multi-Turn Session & Resume (`⌘3` Deploy / `⌘1` Task Inspector, A2A Console & OTel Waterfall)
* **What runs**: Deploys `hero-demo-starter-task` using digest-pinned `ghcr.io/ghchinoy/ax-images/genkit-runner@sha256:f5d7420468b7f1dec8304d7efa1dbe0ca2bb86a1e552181f823630412e01ee06` (`sessionId: "hero-demo-session"`):
  1. **Session Turn 1** adds `def subtract(a, b)` to `math_utils.py` and `test_subtract` to `test_math.py`.
  2. **`ax suspend` $\rightarrow$ `ax resume`** checkpoints `/workspace/.genkit/snapshots` and cold-boots a fresh microVM.
  3. **Session Turn 2** queries the same `contextId: "hero-demo-session"` and recalls `subtract` without re-reading files.
* **What to inspect in AX Central**:
  * **Deploy (`⌘3`)**: Select **`v0.1 Hero Demo: Workspace + Starter Agent`** from **Templates** to view or customize the multi-document `Workspace` + `Task` YAML.
  * **Task Inspector (`⌘1` $\rightarrow$ click `hero-demo-starter-task`)**:
    * Click the **Expand width (`⤢`)** button in the inspector header (`640px` wide mode).
    * **A2A Agent & Prompt Console**: Displays `hero_coder`'s discovered `/.well-known/agent-card.json` metadata and lets you send additional interactive turns (`Session: hero-demo-session`)—including **Wake & Prompt** if the task is `Suspended`!
    * **Logs & Telemetry (`OTel` filter)**: Click any `trace:<shortId>` pill to open the **OpenTelemetry Trace Waterfall** for Turn 1 and Turn 2, preserved across the `Running` $\rightarrow$ `Suspended` $\rightarrow$ `Running` cycle.
* **WebMCP equivalent**: `load_template` (`{ "template": "hero-demo-starter" }`), `prompt_agent` (`{ "name": "hero-demo-starter-task", "prompt": "What function did you add in Turn 1?", "context_id": "hero-demo-session" }`).

---

### Step 4: Custom Image Task — Stock `python:3.12-slim` (`⌘3` Deploy / `⌘1` Guest Logs & Outcome)
* **What runs**: Applies `hero-demo-custom-task` using unmodified stock **`python:3.12-slim`** (`commands: ["python3", "-m", "unittest", "discover", "-s", "/workspace/app", "-p", "test_*.py"]`) bound to `hero-demo-ws`.
* **What to inspect in AX Central**:
  * In **Deploy (`⌘3`)**, select **`v0.1 Hero Demo: Custom Python Unittest`** to inspect the manifest.
  * In **Activity (`⌘1`)**, click `hero-demo-custom-task`:
    * **Outcome** section shows `TASK_RESULT_SUCCEEDED` (`exit 0`).
    * **Logs & Telemetry (`Guest` filter)** shows `workspace already initialized; skipping maiden run setup` (proving warm snapshot hydration on an image without `git`) and `Ran 2 tests ... OK` (proving `ate-local` automatic `/usr/local/bin/ax-task-runner` injection).

---

### Step 5: Cluster Promotion & Cross-Substrate Mobility (`⌘1` Move Task Modal & `⌘2` Map DVR)
* **What runs**: Promotes `hero-demo-ws` and `hero-demo-custom-task` from **Cluster A** (`local` · Apple `container` `:8090`) to **Cluster B** (`local-podman` · Podman `:8091`) and verifies `Ran 2 tests ... OK` on Cluster B.
* **What to inspect in AX Central**:
  * **Interactive UI Promotion (`Move…` `⇄`)**: On any task row in Cluster A (`local`), click **`Move` (`⇄`)** to open `<ax-move-task-modal>`. The **`Current cluster -> Destination cluster`** route banner shows `local (Apple container · localhost:8090)` $\rightarrow$ `local-podman (Podman Cluster B · localhost:8091)` (with proactive collision detection and 1-click **Replace existing**).
  * **Context Switcher**: Switch the top toolbar **Context** dropdown from `local` to **`local-podman`** to inspect the promoted task running on Cluster B (`:8091`).
  * **Map (`⌘2`)**: Use the bottom **Session DVR** scrubber bar to replay the entire 5-step execution timeline across workspaces and tasks.
* **WebMCP equivalent**: `move_task` (`{ "name": "hero-demo-starter-task", "target_context": "local-podman", "target_atespace": "default", "overwrite_existing": true }`), `switch_scope` (`{ "context": "local-podman" }`).
