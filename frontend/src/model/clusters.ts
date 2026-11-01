/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { type ContainerRuntime, ensureStudioBridge } from "../bridge";
import { store } from "./store";

export type Replicas = { ready: number; total: number } | null;

export interface ConsoleLine {
  id: number;
  text: string;
  header?: "start" | "ok" | "fail";
}

export interface Cluster {
  name: string;
  context: string;
  reachable: boolean;
  nodes: Replicas;
  version: string;
  substrate: Replicas;
  substrateCommit: string;
  ax: Replicas;
  workers: Replicas;
  inKubeconfig: boolean;
}

export interface MicroVM {
  name: string;
  state: string;
  ip?: string;
}

export interface PrerequisiteCheck {
  id: string;
  tier: "core" | "ate-local" | "kind";
  title: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix: string;
  installTarget?: string;
}

export interface AppleContainerStack {
  available: boolean;
  daemonRunning: boolean;
  scriptFound: boolean;
  binsBuilt: boolean;
  experimentsFound: boolean;
  agentImageBuilt: boolean;
  postgres: boolean;
  ateLocal: boolean;
  axServer: boolean;
  actors: MicroVM[];
}

export type StageID = "kind" | "substrate" | "workers" | "ax";
export const STAGES: { id: StageID; title: string }[] = [
  { id: "kind", title: "Kind cluster" },
  { id: "substrate", title: "Agent Substrate" },
  { id: "workers", title: "Worker pool" },
  { id: "ax", title: "AX control plane" },
];

export interface Operation {
  kind:
    | "create"
    | "install"
    | "delete"
    | "kubeconfig"
    | "local-up"
    | "local-down"
    | "local-reset"
    | "bootstrap";
  cluster: string;
  stage: StageID | null;
  status: "running" | "ok" | "failed";
  exit?: number;
  started: number;
  finished?: number;
}

export interface NewCluster {
  name: string;
  workers: number;
  substrateRef: string;
}

export interface ClustersState {
  ateLocal: AppleContainerStack;
  doctor: PrerequisiteCheck[];
  clusters: Cluster[];
  loading: boolean;
  loaded: boolean;
  runtime: ContainerRuntime | null;
  machineMemory: number | null;
  tools: Record<"kind" | "kubectl" | "go" | "bash" | "container", boolean>;
  scriptFound: boolean;
  op: Operation | null;
  log: ConsoleLine[];
  form: NewCluster;
}

const SCRIPT = "hack/setup-e2e-kind.sh";
const LOCAL_STACK_SCRIPT = "examples/ate_local/local-stack.sh";
const MIN_MACHINE_MEMORY = 6144;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const PROBE = `
kc=$(mktemp)
if ! kind get kubeconfig --name "$1" > "$kc" 2>/dev/null; then echo reachable=0; rm -f "$kc"; exit 0; fi
k() { kubectl --kubeconfig "$kc" --request-timeout=5s "$@" 2>/dev/null; }
if ! n=$(k get nodes --no-headers); then echo reachable=0; rm -f "$kc"; exit 0; fi
echo reachable=1
echo "nodes=$(printf '%s\\n' "$n" | awk '$2 ~ /^Ready/ { r++ } END { print r+0 "/" NR }')"
echo "version=$(k get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}')"
echo "substrate=$(k -n ate-system get deploy ate-api-server -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
echo "commit=$(k get ns ate-system -o jsonpath='{.metadata.annotations.substrate-commit}')"
echo "ax=$(k -n ax-system get deploy ax-server -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
echo "workers=$(k -n ax-system get workerpool ax-workers -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
rm -f "$kc"
`;

const PROBE_ATE_LOCAL = `
pg=0; sub=0; srv=0; daemon=0; img=0
nc -z 127.0.0.1 "\${AX_LOCAL_POSTGRES_PORT:-5432}" >/dev/null 2>&1 && pg=1
nc -z 127.0.0.1 "\${AX_LOCAL_SUBSTRATE_PORT:-50051}" >/dev/null 2>&1 && sub=1
nc -z 127.0.0.1 "\${AX_LOCAL_SERVER_PORT:-8090}" >/dev/null 2>&1 && srv=1
echo "postgres=$pg"
echo "atelocal=$sub"
echo "axserver=$srv"
if command -v container >/dev/null 2>&1; then
  if container list >/dev/null 2>&1; then
    daemon=1
    container image list 2>/dev/null | grep -q "ax-agent-local" && img=1
    actors=$(container list --all 2>/dev/null | awk 'NR>1 && $1 ~ /^ate-/ {print $1 "|" $5 "|" $6}' | paste -sd, - || true)
    echo "actors=$actors"
  fi
fi
echo "daemon=$daemon"
echo "agentimg=$img"
`;

function replicas(v: string | undefined): Replicas {
  if (!v || !v.includes("/")) return null;
  const [r, t] = v.split("/");
  if (t === "") return null;
  return { ready: Number(r) || 0, total: Number(t) || 0 };
}

function stageFor(line: string): StageID | null {
  if (!line.startsWith("==> ")) return null;
  if (/Kind cluster/.test(line)) return "kind";
  if (/Installing Substrate|Substrate .* already installed/.test(line))
    return "substrate";
  if (/WorkerPool|ax-workers/.test(line)) return "workers";
  if (/Building ax|Deploying ax-postgres/.test(line)) return "ax";
  return null;
}

function parseMicroVMs(raw: string | undefined): MicroVM[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const [name = "", state = "running", ip = ""] = item.split("|");
      return {
        name,
        state: state || "running",
        ...(ip ? { ip } : {}),
      };
    })
    .filter((m) => m.name);
}

export class ClustersStore extends EventTarget {
  state: ClustersState = {
    ateLocal: {
      available: false,
      daemonRunning: false,
      scriptFound: false,
      binsBuilt: false,
      experimentsFound: false,
      agentImageBuilt: false,
      postgres: false,
      ateLocal: false,
      axServer: false,
      actors: [],
    },
    doctor: [],
    clusters: [],
    loading: false,
    loaded: false,
    runtime: null,
    machineMemory: null,
    tools: {
      kind: true,
      kubectl: true,
      go: true,
      bash: true,
      container: false,
    },
    scriptFound: true,
    op: null,
    log: [],
    form: { name: "", workers: 2, substrateRef: "" },
  };

  private lineID = 1;
  private streamID = 0;
  private pending: ConsoleLine[] = [];
  private flushScheduled = false;

  subscribe = (l: () => void): (() => void) => {
    this.addEventListener("change", l);
    return () => this.removeEventListener("change", l);
  };

  set(patch: Partial<ClustersState>): void {
    this.state = { ...this.state, ...patch };
    this.dispatchEvent(new Event("change"));
  }

  setForm(patch: Partial<NewCluster>): void {
    this.set({ form: { ...this.state.form, ...patch } });
  }

  get running(): boolean {
    return this.state.op?.status === "running";
  }

  private async repoDir(): Promise<string> {
    ensureStudioBridge();
    return store.state.settings.repoPath.replace(
      /^~/,
      (await window.studio.platform()).home,
    );
  }

  private env(): Record<string, string> {
    return this.state.runtime?.env ?? {};
  }

  private buildDoctorChecks(
    ateLocal: AppleContainerStack,
    tools: ClustersState["tools"],
    runtime: ContainerRuntime | null,
    machineMemory: number | null,
  ): PrerequisiteCheck[] {
    const repo = store.state.settings.repoPath;
    const exp = store.state.settings.experimentsPath;
    const checks: PrerequisiteCheck[] = [
      {
        id: "go",
        tier: "core",
        title: "Go toolchain",
        status: tools.go ? "ok" : "fail",
        detail: tools.go ? "go installed on PATH" : "go not found on PATH",
        fix: tools.go ? "" : "brew install go",
      },
      {
        id: "apple-container",
        tier: "ate-local",
        title: "Apple container runtime",
        status: !ateLocal.available
          ? "warn"
          : ateLocal.daemonRunning
            ? "ok"
            : "warn",
        detail: !ateLocal.available
          ? "/usr/local/bin/container not found"
          : ateLocal.daemonRunning
            ? "Apple container CLI & daemon running"
            : "Apple container installed; daemon stopped",
        fix: !ateLocal.available
          ? "brew install --cask container && container system start"
          : ateLocal.daemonRunning
            ? ""
            : "container system start",
        installTarget:
          ateLocal.available && !ateLocal.daemonRunning
            ? "container-daemon"
            : undefined,
      },
      {
        id: "ax-repo-variant",
        tier: "ate-local",
        title: "AX repo (ate-local variant)",
        status: ateLocal.scriptFound ? "ok" : "warn",
        detail: ateLocal.scriptFound
          ? `${repo} has examples/ate_local/local-stack.sh`
          : `${repo} missing examples/ate_local/local-stack.sh (needs feat/ate-local-apple-container)`,
        fix: ateLocal.scriptFound
          ? ""
          : `Clone/checkout ghchinoy/ax:feat/ate-local-apple-container in ${repo}`,
        installTarget: ateLocal.scriptFound ? undefined : "ax-repo",
      },
      {
        id: "ate-local-bins",
        tier: "ate-local",
        title: "ate-local & arm64 task runner",
        status: ateLocal.binsBuilt ? "ok" : "warn",
        detail: ateLocal.binsBuilt
          ? `${repo}/.ax-local/bin/{ax,ate-local,ax-server,linux_arm64/ax-task-runner} ready`
          : `${repo}/.ax-local/bin binaries not built yet`,
        fix: ateLocal.binsBuilt ? "" : "Build ate-local & arm64 task runner",
        installTarget:
          !ateLocal.binsBuilt && ateLocal.scriptFound
            ? "ate-local-bins"
            : undefined,
      },
      {
        id: "ax-experiments",
        tier: "ate-local",
        title: "ax-experiments & agent image",
        status:
          ateLocal.experimentsFound && ateLocal.agentImageBuilt ? "ok" : "warn",
        detail: !ateLocal.experimentsFound
          ? `${exp} not found`
          : ateLocal.agentImageBuilt
            ? `${exp} + ax-agent-local:latest image ready`
            : `${exp} present; ax-agent-local:latest image not built`,
        fix: !ateLocal.experimentsFound
          ? `Clone ghchinoy/ax-experiments into ${exp}`
          : ateLocal.agentImageBuilt
            ? ""
            : "container build -t ax-agent-local:latest swarm/agent-image",
        installTarget: !ateLocal.experimentsFound
          ? "ax-experiments"
          : !ateLocal.agentImageBuilt && ateLocal.daemonRunning
            ? "agent-image"
            : undefined,
      },
      {
        id: "kind-stack",
        tier: "kind",
        title: "Kind & container engine",
        status:
          tools.kind &&
          tools.kubectl &&
          runtime?.runtime &&
          (machineMemory === null || machineMemory >= MIN_MACHINE_MEMORY)
            ? "ok"
            : "warn",
        detail:
          !tools.kind || !tools.kubectl
            ? "kind or kubectl not installed (optional for ate-local)"
            : !runtime?.runtime
              ? "neither docker nor podman found"
              : `kind + kubectl + ${runtime.runtime}`,
        fix:
          !tools.kind || !tools.kubectl
            ? "brew install kind kubectl"
            : !runtime?.runtime
              ? "brew install podman"
              : "",
      },
    ];
    return checks;
  }

  async init(): Promise<void> {
    ensureStudioBridge();
    const repo = store.state.settings.repoPath;
    const [runtime, kind, kubectl, go, bash, containerCli, scriptFound] =
      await Promise.all([
        window.studio.containerRuntime(),
        window.studio.which("kind"),
        window.studio.which("kubectl"),
        window.studio.which("go"),
        window.studio.which("bash"),
        window.studio.which("container"),
        window.studio.fileExists(`${repo}/${SCRIPT}`),
      ]);
    this.set({
      runtime,
      tools: {
        kind: !!kind,
        kubectl: !!kubectl,
        go: !!go,
        bash: !!bash,
        container: !!containerCli,
      },
      scriptFound,
    });
    if (runtime.runtime === "podman") {
      const r = await window.studio.run({
        program: "podman",
        args: ["machine", "inspect", "--format", "{{.Resources.Memory}}"],
      });
      const mib = parseInt(r.stdout, 10);
      this.set({ machineMemory: r.status === 0 && mib > 0 ? mib : null });
    }
    await this.refresh();
  }

  private async refreshAteLocal(): Promise<AppleContainerStack> {
    const cur = this.state.ateLocal;
    const repo = store.state.settings.repoPath;
    const exp = store.state.settings.experimentsPath;
    const [
      containerCli,
      localScriptFound,
      binsBuilt,
      experimentsFound,
      probeRes,
    ] = await Promise.all([
      window.studio.which("container"),
      window.studio.fileExists(`${repo}/${LOCAL_STACK_SCRIPT}`),
      window.studio.fileExists(
        `${repo}/.ax-local/bin/linux_arm64/ax-task-runner`,
      ),
      window.studio.fileExists(`${exp}/swarm/README.md`),
      window.studio.run({
        program: "/bin/sh",
        args: ["-c", PROBE_ATE_LOCAL, "probe-ate-local"],
      }),
    ]);
    const kv = Object.fromEntries(
      probeRes.stdout
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [
          l.slice(0, l.indexOf("=")),
          l.slice(l.indexOf("=") + 1).trim(),
        ]),
    );
    const actors = parseMicroVMs(kv.actors);
    const available = !!containerCli;
    const daemonRunning =
      kv.daemon === "1" || (available && kv.axserver === "1");
    const agentImageBuilt = kv.agentimg === "1";
    return {
      ...cur,
      available,
      daemonRunning,
      scriptFound: localScriptFound,
      binsBuilt,
      experimentsFound,
      agentImageBuilt,
      postgres: kv.postgres === "1",
      ateLocal: kv.atelocal === "1",
      axServer: kv.axserver === "1",
      actors,
    };
  }

  async refresh(): Promise<void> {
    ensureStudioBridge();
    this.set({ loading: true });
    try {
      const ateLocalPromise = this.refreshAteLocal();
      if (!this.state.tools.kind || !this.state.runtime?.runtime) {
        const ateLocal = await ateLocalPromise;
        const doctor = this.buildDoctorChecks(
          ateLocal,
          this.state.tools,
          this.state.runtime,
          this.state.machineMemory,
        );
        this.set({ ateLocal, doctor, clusters: [], loaded: true });
        return;
      }
      const env = this.env();
      const [ateLocal, list, ctxs] = await Promise.all([
        ateLocalPromise,
        window.studio.run({ program: "kind", args: ["get", "clusters"], env }),
        window.studio.run({
          program: "kubectl",
          args: ["config", "get-contexts", "-o", "name"],
        }),
      ]);
      const names =
        list.status === 0
          ? list.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l && !l.includes(" "))
          : [];
      const contexts = new Set(ctxs.stdout.split("\n").map((l) => l.trim()));
      const clustersList = await Promise.all(
        names.map(async (name): Promise<Cluster> => {
          const r = await window.studio.run({
            program: "/bin/sh",
            args: ["-c", PROBE, "probe", name],
            env,
          });
          const kv = Object.fromEntries(
            r.stdout
              .split("\n")
              .filter((l) => l.includes("="))
              .map((l) => [
                l.slice(0, l.indexOf("=")),
                l.slice(l.indexOf("=") + 1),
              ]),
          );
          return {
            name,
            context: `kind-${name}`,
            reachable: kv.reachable === "1",
            nodes: replicas(kv.nodes),
            version: kv.version ?? "",
            substrate: replicas(kv.substrate),
            substrateCommit: kv.commit ?? "",
            ax: replicas(kv.ax),
            workers: replicas(kv.workers),
            inKubeconfig: contexts.has(`kind-${name}`),
          };
        }),
      );
      const form = this.state.form.name
        ? this.state.form
        : { ...this.state.form, name: freeName(names) };
      const doctor = this.buildDoctorChecks(
        ateLocal,
        this.state.tools,
        this.state.runtime,
        this.state.machineMemory,
      );
      this.set({ ateLocal, doctor, clusters: clustersList, form });
    } finally {
      this.set({ loading: false, loaded: true });
    }
  }

  get problems(): string[] {
    const p: string[] = [];
    const { tools, runtime } = this.state;
    if (!tools.kind)
      p.push("kind is not installed (https://kind.sigs.k8s.io).");
    if (runtime && !runtime.runtime)
      p.push("Neither docker nor podman is installed.");
    if (!tools.kubectl) p.push("kubectl is not installed.");
    return p;
  }

  get buildProblems(): string[] {
    const p: string[] = [];
    if (!this.state.scriptFound)
      p.push(
        `${SCRIPT} not found in ${store.state.settings.repoPath} (set the AX repo in Settings).`,
      );
    if (!this.state.tools.go)
      p.push("Go is not installed; Substrate and AX are built from source.");
    if (!this.state.tools.bash)
      p.push("bash is required to run the setup script.");
    return p;
  }

  get warnings(): string[] {
    const mib = this.state.machineMemory;
    if (mib === null || mib >= MIN_MACHINE_MEMORY) return [];
    return [
      `The podman machine has ${Math.round(mib / 1024)} GiB of memory; building Agent Substrate needs about ${MIN_MACHINE_MEMORY / 1024} GiB and is killed with less. Run: podman machine stop && podman machine set --memory 8192 && podman machine start`,
    ];
  }

  nameProblem(name: string): string | null {
    if (!name) return "Name the cluster.";
    if (!NAME_RE.test(name)) return "Use lowercase letters, digits and dashes.";
    if (this.state.clusters.some((c) => c.name === name))
      return `A kind cluster named ${name} already exists.`;
    return null;
  }

  private setupCommand(
    name: string,
    workers: number,
    substrateRef: string,
  ): string {
    const tmp = `.tmp/kubeconfig-${name}`;
    return [
      "set -e",
      "ORIG=${KUBECONFIG:-$HOME/.kube/config}; ORIG=${ORIG%%:*}",
      `KUBECONFIG="$PWD/${tmp}" KIND_CLUSTER_NAME=${shq(name)} AX_WORKER_REPLICAS=${workers} AX_SNAPSHOTS_BUCKET=` +
        `${substrateRef ? ` SUBSTRATE_REF=${shq(substrateRef)}` : ""} bash ${SCRIPT}`,
      `printf '\\n==> Adding context kind-%s to %s\\n' ${shq(name)} "$ORIG"`,
      mergeScript(tmp),
    ].join("\n");
  }

  async create(): Promise<void> {
    const { name, workers, substrateRef } = this.state.form;
    await this.exec(
      { kind: "create", cluster: name },
      `Create ${name}`,
      this.setupCommand(name, workers, substrateRef.trim()),
    );
  }

  async install(name: string): Promise<void> {
    await this.exec(
      { kind: "install", cluster: name },
      `Install AX on ${name}`,
      this.setupCommand(
        name,
        this.state.form.workers,
        this.state.form.substrateRef.trim(),
      ),
    );
  }

  async remove(name: string): Promise<void> {
    await this.exec(
      { kind: "delete", cluster: name },
      `Delete ${name}`,
      `kind delete cluster --name ${shq(name)} && rm -f .tmp/kubeconfig-${name}`,
    );
  }

  async localStackUp(): Promise<boolean> {
    return this.exec(
      { kind: "local-up", cluster: "ate-local" },
      "Start Apple Container stack (ate-local)",
      `bash ${LOCAL_STACK_SCRIPT} up`,
    );
  }

  async localStackDown(): Promise<boolean> {
    return this.exec(
      { kind: "local-down", cluster: "ate-local" },
      "Stop Apple Container stack (ate-local)",
      `bash ${LOCAL_STACK_SCRIPT} down`,
    );
  }

  async localStackReset(): Promise<boolean> {
    return this.exec(
      { kind: "local-reset", cluster: "ate-local" },
      "Reset Apple Container stack (ate-local)",
      `bash ${LOCAL_STACK_SCRIPT} reset`,
    );
  }

  async bootstrap(target = "all"): Promise<boolean> {
    const info = await window.studio.platform();
    const repo = store.state.settings.repoPath.replace(/^~/, info.home);
    const exp = store.state.settings.experimentsPath.replace(/^~/, info.home);
    const script = [
      "set -e",
      `AX_REPO=${shq(repo)}`,
      `AX_EXPERIMENTS_REPO=${shq(exp)}`,
      target === "container-daemon"
        ? "container system start"
        : target === "ax-repo"
          ? 'if [ ! -d "$AX_REPO/.git" ]; then git clone -b feat/ate-local-apple-container https://github.com/ghchinoy/ax.git "$AX_REPO"; else cd "$AX_REPO" && git checkout feat/ate-local-apple-container; fi'
          : target === "ate-local-bins"
            ? 'cd "$AX_REPO" && mkdir -p .ax-local/bin/linux_arm64 && go build -o .ax-local/bin/ate-local ./cmd/ate-local && go build -o .ax-local/bin/ax-server ./cmd/ax-server && go build -o .ax-local/bin/ax ./cmd/ax && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o .ax-local/bin/linux_arm64/ax-task-runner ./cmd/ax-task-runner'
            : target === "ax-experiments"
              ? 'if [ ! -d "$AX_EXPERIMENTS_REPO/.git" ]; then git clone https://github.com/ghchinoy/ax-experiments.git "$AX_EXPERIMENTS_REPO"; fi'
              : target === "agent-image"
                ? 'container build -t ax-agent-local:latest "$AX_EXPERIMENTS_REPO/swarm/agent-image"'
                : [
                    "command -v container >/dev/null && ! container list >/dev/null 2>&1 && container system start || true",
                    '[ ! -d "$AX_REPO/.git" ] && git clone -b feat/ate-local-apple-container https://github.com/ghchinoy/ax.git "$AX_REPO" || true',
                    'if [ -d "$AX_REPO/cmd/ate-local" ] && [ ! -x "$AX_REPO/.ax-local/bin/linux_arm64/ax-task-runner" ]; then (cd "$AX_REPO" && mkdir -p .ax-local/bin/linux_arm64 && go build -o .ax-local/bin/ate-local ./cmd/ate-local && go build -o .ax-local/bin/ax-server ./cmd/ax-server && go build -o .ax-local/bin/ax ./cmd/ax && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o .ax-local/bin/linux_arm64/ax-task-runner ./cmd/ax-task-runner); fi',
                    '[ ! -d "$AX_EXPERIMENTS_REPO/.git" ] && git clone https://github.com/ghchinoy/ax-experiments.git "$AX_EXPERIMENTS_REPO" || true',
                    'if command -v container >/dev/null && container list >/dev/null 2>&1 && [ -d "$AX_EXPERIMENTS_REPO/swarm/agent-image" ] && ! container image list 2>/dev/null | grep -q ax-agent-local; then container build -t ax-agent-local:latest "$AX_EXPERIMENTS_REPO/swarm/agent-image"; fi',
                  ].join("\n"),
    ].join("\n");
    const ok = await this.exec(
      { kind: "bootstrap", cluster: target },
      `Bootstrap ${target}`,
      script,
    );
    if (ok) {
      await store.loadContexts();
    }
    return ok;
  }

  async openLocalStack(): Promise<void> {
    await store.loadContexts();
    store.setScope({ context: "local" });
    store.setSection("overview");
  }

  async addToKubeconfig(name: string): Promise<boolean> {
    const tmp = `$TMPDIR/ax-central-kind-${name}.yaml`;
    const ok = await this.exec(
      { kind: "kubeconfig", cluster: name },
      `Add kind-${name} to kubeconfig`,
      [
        "set -e",
        "ORIG=${KUBECONFIG:-$HOME/.kube/config}; ORIG=${ORIG%%:*}",
        `TMPDIR=\${TMPDIR:-/tmp}; kind get kubeconfig --name ${shq(name)} > "${tmp}"`,
        mergeScript(tmp),
        `rm -f "${tmp}"`,
        `echo "kind-${name} added to $ORIG"`,
      ].join("\n"),
    );
    return ok;
  }

  async open(c: Cluster): Promise<void> {
    if (!c.inKubeconfig && !(await this.addToKubeconfig(c.name))) return;
    await store.loadContexts();
    store.setScope({ context: c.context });
    store.setSection("overview");
  }

  cancel(): void {
    void window.studio.cancelStream(`clusters-${this.streamID}`);
  }

  private append(text: string, header?: ConsoleLine["header"]): void {
    this.pending.push({ id: this.lineID++, text, header });
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      const log = [...this.state.log, ...this.pending].slice(-5000);
      this.pending = [];
      this.set({ log });
    });
  }

  private patchOp(patch: Partial<Operation>): void {
    if (this.state.op) this.set({ op: { ...this.state.op, ...patch } });
  }

  private async exec(
    op: Pick<Operation, "kind" | "cluster">,
    title: string,
    command: string,
  ): Promise<boolean> {
    if (this.running) return false;
    const staged = op.kind === "create" || op.kind === "install";
    this.set({
      op: {
        ...op,
        stage: staged ? "kind" : null,
        status: "running",
        started: Date.now(),
      },
      log: [],
    });
    this.append(`▶ ${title}`, "start");
    const streamID = `clusters-${++this.streamID}`;
    const cwd = await this.repoDir();
    const status = await new Promise<number>((resolve) => {
      const offLine = window.studio.onStreamLine((l) => {
        if (l.id !== streamID) return;
        this.append(l.line);
        const stage = staged ? stageFor(l.line) : null;
        if (stage) this.patchOp({ stage });
      });
      const offExit = window.studio.onStreamExit((e) => {
        if (e.id !== streamID) return;
        offLine();
        offExit();
        resolve(e.status);
      });
      void window.studio.stream({
        id: streamID,
        commandLine: command,
        cwd,
        env: this.env(),
      });
    });
    const ok = status === 0;
    this.patchOp({
      status: ok ? "ok" : "failed",
      exit: status,
      finished: Date.now(),
    });
    this.append(
      ok ? `✓ ${title} done` : `✗ ${title} failed (exit ${status})`,
      ok ? "ok" : "fail",
    );
    if (ok && op.kind === "create") this.setForm({ name: "" });
    void this.refresh();
    return ok;
  }
}

function mergeScript(src: string): string {
  return [
    'mkdir -p "$(dirname "$ORIG")"',
    '[ -f "$ORIG" ] && cp "$ORIG" "$ORIG.ax-central.bak"',
    `KUBECONFIG="$ORIG:${src}" kubectl config view --flatten > "$ORIG.ax-central.tmp"`,
    'mv "$ORIG.ax-central.tmp" "$ORIG"',
  ].join("\n");
}

function freeName(taken: string[]): string {
  if (!taken.includes("ax-dev")) return "ax-dev";
  for (let i = 2; ; i++)
    if (!taken.includes(`ax-dev-${i}`)) return `ax-dev-${i}`;
}

export const clusters = new ClustersStore();
