# Walkthrough: Live 5/5 AX v0.1 Hero Demo in AX Central

This walkthrough covers prerequisites, pre-recording reset steps, a ~2m 45s spoken presenter script, and a view-by-view reference for running all five steps of the **[AX v0.1 Hero Demo](https://github.com/google/ax/pull/590)** (`5/5 🟢 PASS`) live inside **AX Central** across **Cluster A** (macOS Apple `container` microVMs on `:8090` / `:50051`) and **Cluster B** (Podman containers on `:8091` / `:50052`).

---

## Prerequisites & Pre-Recording Setup

### 1. Environment & Runtime Prerequisites
Before starting a live demo or screen recording, verify these four items:

* **Prerequisite Doctor (`make doctor`)**: Confirm Go `1.26+`, the Apple `container` system daemon (`container system start`), `~/projects/ax`, and `~/projects/ax-experiments` report `OK`:
  ```bash
  make -C ~/projects/ax-central doctor
  ```
* **Podman Machine (Cluster B on `:8091`)**: Ensure `podman machine start` has been run if you want Step 5 to promote from Apple `container` microVMs to Podman containers (otherwise `local-stack.sh multi-up` falls back to a second isolated Apple `container` daemon).
* **Live Gemini API Key (`GEMINI_API_KEY`)**: Export `GEMINI_API_KEY` in your login shell (`~/.zshrc` or `~/.zprofile`) so `AX Central.app` inherits it via `shell.go` and Step 3 executes live multi-turn Gemini sessions (`live-gemini`) rather than offline mock turns.
* **Warm Image Cache (recommended before recording)**: Pre-pull the three container images once so Steps 2–5 never wait on network downloads on camera:
  ```bash
  container image pull alpine/git
  container image pull python:3.12-slim
  container image pull ghcr.io/ghchinoy/ax-images/genkit-runner@sha256:f5d7420468b7f1dec8304d7efa1dbe0ca2bb86a1e552181f823630412e01ee06
  podman pull python:3.12-slim
  ```

### 2. Fresh Slate Before Hitting Record (~3 Seconds)
To clear out earlier test tasks, PostgreSQL state, and leftover Apple `container` / Podman sandboxes so AX Central starts clean:

```bash
# In ~/projects/ax: reset PostgreSQL + Cluster A, clear warm snapshot archives so
# Step 2 demonstrates the cold-to-warm Tag pre-warm live, and boot Cluster B (:8091)
cd ~/projects/ax && \
  ./examples/ate_local/local-stack.sh reset && \
  rm -rf .ax-local/snapshots/* && \
  make local-multi-up
```

Or run the equivalent one-liner from `~/projects/ax-central`:

```bash
bash hack/demo-hero-central.sh --reset-only
open "/Users/ghchinoy/projects/ax-central/build/bin/AX Central.app"
```

---

## Launch Options

You can trigger the 5-step demo from the AX Central UI, from the CLI presenter script, or via WebMCP:

```bash
# Option A: In-app 1-click run (recommended for video demos)
#   Press ⌘5 (Clusters) -> click "▶ Run v0.1 Hero Demo (5/5)"

# Option B: One-shot CLI run attached to AX Central (:8090 / :8091), keeping resources live
make demo-hero

# Option C: Interactive presenter mode (pauses before each step so you can click through AX Central)
bash hack/demo-hero-central.sh --interactive
```

Or press **`⌘I`** (**WebMCP Inspector**) inside `AX Central.app` and execute **`run_hero_demo`** with `{ "attach": true, "keep_stack": true }`.

---

## Spoken Presenter Script & Cue Sheet (~2m 45s)

### Beat 0: Cold Open — What We Are Showing (`0:00 – 0:20`, on `⌘5` Clusters)
* **On screen**: `AX Central.app` open on **Clusters (`⌘5`)**, displaying **Apple Container (`ate-local`)**, **Podman Cluster B (`ate-local-b`)**, and the **AX v0.1 Hero Demo** card on the right (`0/5 PASS`).
* **Voiceover**:
  > *"This is AX Central, a lightweight native desktop control plane for AX and Agent Substrate built with Go and Lit WebComponents.*
  > *Upstream AX defines a five-step v0.1 Hero Demo scoreboard covering local startup, warm workspace snapshots, multi-turn agent sessions across suspend and resume, running an unmodified stock container image, and promoting workloads across clusters.*
  > *Today, four of those five steps are still stubs on upstream main. Let's run all five live, end-to-end, right from AX Central."*

### Beat 1: Kick Off the 5/5 Live Run (`0:20 – 0:55`, click `Run v0.1 Hero Demo (5/5)`)
* **Action**: Click **`▶ Run v0.1 Hero Demo (5/5)`** on the **AX v0.1 Hero Demo** card. The bottom **Output** console opens automatically and each step transitions from a spinning blue loader to a green check (`5/5 PASS`).
* **Voiceover (spoken while Steps 1–5 stream over ~30 seconds)**:
  > *"Step 1 verifies our dual-cluster local substrate: Cluster A runs Linux microVMs on macOS's native Apple Container hypervisor on port 8090, and Cluster B runs Podman on port 8091, each with an embedded `atenet-router`.*
  > *Step 2 applies `hero-demo-ws`, runs its setup commands once to initialize a Python repository, and mints an immutable warm snapshot tag so future sandboxes skip maiden git setup.*
  > *Step 3 boots our digest-pinned Genkit coding agent against that workspace. Turn 1 writes a new `subtract` function and unit test; AX then suspends the task, tears down the microVM, cold-boots a new VM, and sends Turn 2 on the same session ID, recalling Turn 1 from its persisted workspace snapshot.*
  > *Step 4 runs upstream's unmodified `python:3.12-slim` image, with no custom Dockerfile and no `git` binary installed, injecting `ax-task-runner` automatically and passing both unit tests.*
  > *And Step 5 promotes those exact same manifests unchanged to Cluster B on Podman: five out of five green."*

### Beat 2: Inspect Warm Snapshots & Post-Mortem Archives (`0:55 – 1:20`, press `⌘1` Activity)
* **Action**: Press **`⌘1`** (**Activity**). Point out `hero-demo-ws` in **Workspaces**, scroll to **Workspace Snapshots**, click **`Inspect`** on a `.tar.gz` snapshot archive to preview `app/math_utils.py` and `app/test_math.py`, then close the modal.
* **Voiceover**:
  > *"Switching to Activity, all of the demo resources remain live on Cluster A.*
  > *Down in Workspace Snapshots, AX Central indexes the `.tar.gz` volume checkpoints written by `ate-local` on suspend. Even after short-lived containers scale to zero or finish executing, we can inspect the exact files the agent wrote inside `/workspace`."*

### Beat 3: Native A2A Prompt Console & OTel Trace Waterfall (`1:20 – 2:00`, click `hero-demo-starter-task`)
* **Action**:
  1. Click **`hero-demo-starter-task`** in the **Tasks** table to open `<ax-task-inspector>`.
  2. Click **Expand width (`⤢`)** in the inspector header (`380px` $\rightarrow$ `640px`).
  3. Highlight **A2A Agent & Prompt Console** (`Session: hero-demo-session`, showing **`Wake & Prompt`** while `Suspended`), and click **`OTel`** in **Logs & Telemetry** (or click a `trace:<shortId>` pill to open the waterfall).
  4. *(Optional live turn)*: Type `"Summarize math_utils.py in one sentence"` and click **`Wake & Prompt`**.
* **Voiceover**:
  > *"Opening `hero-demo-starter-task` and widening the inspector, we see the v1alpha1 task metadata, Actor UID, and our native A2A Agent and Prompt Console.*
  > *Notice the task is Suspended, consuming zero CPU and zero RAM. Because AX Central speaks A2A through `atenet-router`, we can send a follow-up prompt on `hero-demo-session` and click **Wake & Prompt**: AX Central wakes the microVM automatically, dispatches the JSON-RPC turn with a W3C `traceparent` header, and links the reply to the Genkit OpenTelemetry trace waterfall below, preserved across scale-to-zero transitions."*

### Beat 4: Stock Image Outcome, Cross-Cluster Promotion & Map DVR (`2:00 – 2:45`, `hero-demo-custom-task` $\rightarrow$ `local-podman` $\rightarrow$ `⌘2` Map)
* **Action**:
  1. Click **`hero-demo-custom-task`** to show **Outcome** (`TASK_RESULT_SUCCEEDED`) and **`Guest` logs** (`workspace already initialized; skipping maiden run setup` and `Ran 2 tests ... OK`).
  2. Click **`Move` (`⇄`)** on a task row to show the **`Current cluster -> Destination cluster`** banner (`local :8090` $\rightarrow$ `local-podman :8091`) and collision handling, then close the modal and switch the top **Context** picker to **`local-podman`** (showing `hero-demo-custom-task` on Cluster B) and back to **`local`**.
  3. Press **`⌘2`** (**Map**) to scrub the bottom **Session DVR** slider, and press **`⌘I`** to show the **23 WebMCP tools**.
* **Voiceover**:
  > *"Selecting `hero-demo-custom-task`, the Guest logs confirm that stock `python:3.12-slim` skipped maiden git setup using the warm snapshot and passed both unit tests.*
  > *We can migrate live tasks and their `/workspace` volumes across clusters or atespaces over `ax ssh` from the Move modal, or switch the Context picker to `local-podman` on port 8091 to inspect the promoted task running on Cluster B.*
  > *In Map view, the Session DVR timeline replays every workspace mount and task wakeup, and all 23 operations are registered on `document.modelContext` as WebMCP tools so browser and desktop AI agents can drive AX Central programmatically."*

---

## Step-by-Step Reference Across AX Central Views

### Step 1: Local Up & Studio (`⌘5` Clusters)
* **What runs**: `examples/ate_local/local-stack.sh multi-up` boots **Cluster A** (`ax-server :8090` + `ate-local` Control & embedded `atenet-router :50051` on Apple `container`) and **Cluster B** (`ax-server-b :8091` + `ate-local-b :50052` on Podman), sharing `~/projects/ax/.ax-local/snapshots`.
* **What to inspect in AX Central**:
  * In **Clusters (`⌘5`)**, both the **Apple Container (`ate-local`)** card and the **Podman Cluster B (`ate-local-b`)** card report `Ready`.
  * In the **AX v0.1 Hero Demo** card on the right, `1. Local Up & Studio` marks `PASS`.
* **WebMCP equivalent**: `manage_local_stack` (`{ "action": "multi-up" }`), `list_clusters`.

### Step 2: Warm Workspace Snapshot (`⌘1` Activity $\rightarrow$ Workspaces & Snapshots)
* **What runs**: Applies `hero-demo-ws` (`Workspace.spec.setup.commands` running `git init /workspace/app` and writing `math_utils.py` + `test_math.py`), pre-warms the workspace, checkpoints `/workspace` on suspend, and mints the immutable Agent Substrate v1.0 `Tag` **`hero-demo-ws-warm`** (`SNAPSHOT_STORAGE_STATE_COMPLETED`), verifying warm wake-on-request (`HTTP 200`) through `atenet-router`.
* **What to inspect in AX Central**:
  * Press **`⌘1`** (**Activity**): `hero-demo-ws` appears in the **Workspaces** table.
  * Scroll to **Workspace Snapshots** at the bottom of Activity and click **`Inspect`** on the `.tar.gz` archive to browse `app/math_utils.py` and `app/test_math.py` on disk.
* **WebMCP equivalent**: `list_workspaces`.

### Step 3: Starter Task, Multi-Turn Session & Resume (`⌘3` Deploy / `⌘1` Task Inspector, A2A Console & OTel Waterfall)
* **What runs**: Deploys `hero-demo-starter-task` using digest-pinned `ghcr.io/ghchinoy/ax-images/genkit-runner@sha256:f5d7420468b7f1dec8304d7efa1dbe0ca2bb86a1e552181f823630412e01ee06` (`sessionId: "hero-demo-session"`):
  1. **Session Turn 1** adds `def subtract(a, b)` to `math_utils.py` and `test_subtract` to `test_math.py`.
  2. **`ax suspend` $\rightarrow$ `ax resume`** checkpoints `/workspace/.genkit/snapshots` and cold-boots a fresh microVM.
  3. **Session Turn 2** queries the same `contextId: "hero-demo-session"` and recalls `subtract` without re-reading files.
* **What to inspect in AX Central**:
  * **Deploy (`⌘3`)**: Select **`v0.1 Hero Demo: Workspace + Starter Agent`** from **Templates** to view or customize the multi-document `Workspace` + `Task` YAML.
  * **Task Inspector (`⌘1` $\rightarrow$ click `hero-demo-starter-task`)**:
    * Click the **Expand width (`⤢`)** button in the inspector header (`640px` wide mode).
    * **A2A Agent & Prompt Console**: Displays `hero_coder`'s discovered `/.well-known/agent-card.json` metadata and lets you send additional interactive turns (`Session: hero-demo-session`), including **Wake & Prompt** when the task is `Suspended`.
    * **Logs & Telemetry (`OTel` filter)**: Click any `trace:<shortId>` pill to open the **OpenTelemetry Trace Waterfall** for Turn 1 and Turn 2, preserved across the `Running` $\rightarrow$ `Suspended` $\rightarrow$ `Running` cycle.
* **WebMCP equivalent**: `load_template` (`{ "template": "hero-demo-starter" }`), `prompt_agent` (`{ "name": "hero-demo-starter-task", "prompt": "What function did you add in Turn 1?", "context_id": "hero-demo-session" }`).

### Step 4: Custom Image Task — Stock `python:3.12-slim` (`⌘3` Deploy / `⌘1` Guest Logs & Outcome)
* **What runs**: Applies `hero-demo-custom-task` using unmodified stock **`python:3.12-slim`** (`commands: ["python3", "-m", "unittest", "discover", "-s", "/workspace/app", "-p", "test_*.py"]`) bound to `hero-demo-ws`.
* **What to inspect in AX Central**:
  * In **Deploy (`⌘3`)**, select **`v0.1 Hero Demo: Custom Python Unittest`** to inspect the manifest.
  * In **Activity (`⌘1`)**, click `hero-demo-custom-task`:
    * **Outcome** section shows `TASK_RESULT_SUCCEEDED` (`exit 0`).
    * **Logs & Telemetry (`Guest` filter)** shows `workspace already initialized; skipping maiden run setup` (proving warm snapshot hydration on an image without `git`) and `Ran 2 tests ... OK` (proving `ate-local` automatic `/usr/local/bin/ax-task-runner` injection).

### Step 5: Cluster Promotion & Cross-Substrate Mobility (`⌘1` Move Task Modal & `⌘2` Map DVR)
* **What runs**: Promotes `hero-demo-ws` and `hero-demo-custom-task` from **Cluster A** (`local` · Apple `container` `:8090`) to **Cluster B** (`local-podman` · Podman `:8091`) and verifies `Ran 2 tests ... OK` on Cluster B.
* **What to inspect in AX Central**:
  * **Interactive UI Promotion (`Move…` `⇄`)**: On any task row in Cluster A (`local`), click **`Move` (`⇄`)** to open `<ax-move-task-modal>`. The **`Current cluster -> Destination cluster`** route banner shows `local (Apple container · localhost:8090)` $\rightarrow$ `local-podman (Podman Cluster B · localhost:8091)` (with proactive collision detection and 1-click **Replace existing**).
  * **Context Switcher**: Switch the top toolbar **Context** dropdown from `local` to **`local-podman`** to inspect the promoted task running on Cluster B (`:8091`).
  * **Map (`⌘2`)**: Use the bottom **Session DVR** scrubber bar to replay the 5-step execution timeline across workspaces and tasks.
* **WebMCP equivalent**: `move_task` (`{ "name": "hero-demo-starter-task", "target_context": "local-podman", "target_atespace": "default", "overwrite_existing": true }`), `switch_scope` (`{ "context": "local-podman" }`).
