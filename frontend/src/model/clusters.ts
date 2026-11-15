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
import { isSafeResourceName, shortName } from "./resources";
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
  isKind?: boolean;
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
  ateLocalB: boolean;
  axServerB: boolean;
  podmanAvailable: boolean;
  podmanActors: MicroVM[];
}

export type StageID = "kind" | "substrate" | "workers" | "ax";
export const STAGES: { id: StageID; title: string }[] = [
  { id: "kind", title: "Kind cluster" },
  { id: "substrate", title: "Agent Substrate" },
  { id: "workers", title: "Worker pool" },
  { id: "ax", title: "AX control plane" },
];

export interface HeroDemoStep {
  step: number;
  title: string;
  status: "pending" | "running" | "pass" | "stub" | "fail";
  note: string;
}

export const HERO_DEMO_STEPS: HeroDemoStep[] = [
  { step: 1, title: "1. Local Up & Studio", status: "pending", note: "" },
  { step: 2, title: "2. Warm Workspace Snapshot", status: "pending", note: "" },
  {
    step: 3,
    title: "3. Starter Task, Session & Resume",
    status: "pending",
    note: "",
  },
  { step: 4, title: "4. Custom Image Task", status: "pending", note: "" },
  {
    step: 5,
    title: "5. Remote Cluster Promotion",
    status: "pending",
    note: "",
  },
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
    | "bootstrap"
    | "hero-demo";
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
  heroScoreboard: HeroDemoStep[];
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
name="$1"; ctx="\${2:-kind-$1}"; kc=""
if [ "\${ctx#kind-}" != "$ctx" ] && command -v kind >/dev/null 2>&1; then
  kc=$(mktemp)
  if ! kind get kubeconfig --name "$name" > "$kc" 2>/dev/null; then
    rm -f "$kc"; kc=""
  fi
fi
k() {
  if [ -n "$kc" ]; then
    kubectl --kubeconfig "$kc" --request-timeout=5s "$@" 2>/dev/null
  else
    kubectl --context "$ctx" --request-timeout=5s "$@" 2>/dev/null
  fi
}
cleanup_kc() { [ -n "$kc" ] && rm -f "$kc" || true; }
if ! n=$(k get nodes --no-headers); then echo reachable=0; cleanup_kc; exit 0; fi
echo reachable=1
echo "nodes=$(printf '%s\\n' "$n" | awk '$2 ~ /^Ready/ { r++ } END { print r+0 "/" NR }')"
echo "version=$(k get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}')"
echo "substrate=$(k -n ate-system get deploy ate-api-server -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
echo "commit=$(k get ns ate-system -o jsonpath='{.metadata.annotations.substrate-commit}')"
echo "ax=$(k -n ax-system get deploy ax-server -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
echo "workers=$(k -n ax-system get workerpool ax-workers -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
cleanup_kc
`;

const PROBE_ATE_LOCAL = `
pg=0; sub=0; srv=0; subb=0; srvb=0; daemon=0; img=0; podman=0
nc -z 127.0.0.1 "\${AX_LOCAL_POSTGRES_PORT:-5432}" >/dev/null 2>&1 && pg=1
nc -z 127.0.0.1 "\${AX_LOCAL_SUBSTRATE_PORT:-50051}" >/dev/null 2>&1 && sub=1
nc -z 127.0.0.1 "\${AX_LOCAL_SERVER_PORT:-8090}" >/dev/null 2>&1 && srv=1
nc -z 127.0.0.1 "\${AX_LOCAL_SUBSTRATE_B_PORT:-50052}" >/dev/null 2>&1 && subb=1
nc -z 127.0.0.1 "\${AX_LOCAL_SERVER_B_PORT:-8091}" >/dev/null 2>&1 && srvb=1
echo "postgres=$pg"
echo "atelocal=$sub"
echo "axserver=$srv"
echo "atelocalb=$subb"
echo "axserverb=$srvb"
if command -v container >/dev/null 2>&1; then
  if container list >/dev/null 2>&1; then
    daemon=1
    container image list 2>/dev/null | grep -q "ax-agent-local" && img=1
    actors=$(container list --all 2>/dev/null | awk 'NR>1 && $1 ~ /^ate-/ {print $1 "|" $5 "|" $6}' | paste -sd, - || true)
    echo "actors=$actors"
  fi
fi
if command -v podman >/dev/null 2>&1; then
  podman=1
  pactors=$(podman ps -a --format '{{.Names}}|{{.State}}|127.0.0.1' 2>/dev/null | awk -F'|' '$1 ~ /^ate-/ {print $0}' | paste -sd, - || true)
  echo "pactors=$pactors"
fi
echo "daemon=$daemon"
echo "agentimg=$img"
echo "podman=$podman"
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
      ateLocalB: false,
      axServerB: false,
      podmanAvailable: false,
      podmanActors: [],
    },
    doctor: [],
    heroScoreboard: HERO_DEMO_STEPS.map((s) => ({ ...s })),
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
    const isLinux = store.state.os === "linux";
    const repoReadyOnLinux = isLinux && this.state.scriptFound;
    const binsReadyOnLinux = isLinux && !!store.state.repoAxBin;
    const expReadyOnLinux = isLinux && ateLocal.experimentsFound;
    const checks: PrerequisiteCheck[] = [
      {
        id: "go",
        tier: "core",
        title: "Go toolchain",
        status: tools.go ? "ok" : "fail",
        detail: tools.go ? "go installed on PATH" : "go not found on PATH",
        fix: tools.go
          ? ""
          : isLinux
            ? "sudo apt-get install -y golang-go"
            : "brew install go",
      },
      {
        id: "apple-container",
        tier: "ate-local",
        title: "Apple container runtime",
        status: !ateLocal.available
          ? isLinux
            ? "ok"
            : "warn"
          : ateLocal.daemonRunning
            ? "ok"
            : "warn",
        detail: !ateLocal.available
          ? isLinux
            ? "macOS-only (Linux/Crostini uses Kind + gVisor)"
            : "/usr/local/bin/container not found"
          : ateLocal.daemonRunning
            ? "Apple container CLI & daemon running"
            : "Apple container installed; daemon stopped",
        fix: !ateLocal.available
          ? isLinux
            ? ""
            : "brew install --cask container && container system start"
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
        title: isLinux
          ? "AX repo (Kind / Crostini)"
          : "AX repo (ate-local variant)",
        status: ateLocal.scriptFound || repoReadyOnLinux ? "ok" : "warn",
        detail: ateLocal.scriptFound
          ? `${repo} has examples/ate_local/local-stack.sh`
          : repoReadyOnLinux
            ? `${repo} has ${SCRIPT}`
            : `${repo} missing examples/ate_local/local-stack.sh (needs feat/ate-local-apple-container)`,
        fix:
          ateLocal.scriptFound || repoReadyOnLinux
            ? ""
            : `Clone/checkout ghchinoy/ax:feat/ate-local-apple-container in ${repo}`,
        installTarget:
          ateLocal.scriptFound || repoReadyOnLinux ? undefined : "ax-repo",
      },
      {
        id: "ate-local-bins",
        tier: "ate-local",
        title: isLinux ? "ax CLI binary" : "ate-local & arm64 task runner",
        status: ateLocal.binsBuilt || binsReadyOnLinux ? "ok" : "warn",
        detail: ateLocal.binsBuilt
          ? `${repo}/.ax-local/bin/{ax,ate-local,ax-server,linux_arm64/ax-task-runner} ready`
          : binsReadyOnLinux
            ? `${store.state.repoAxBin} ready`
            : `${repo}/.ax-local/bin binaries not built yet`,
        fix:
          ateLocal.binsBuilt || binsReadyOnLinux
            ? ""
            : "Build ate-local & arm64 task runner",
        installTarget:
          !ateLocal.binsBuilt && !binsReadyOnLinux && ateLocal.scriptFound
            ? "ate-local-bins"
            : undefined,
      },
      {
        id: "ax-experiments",
        tier: "ate-local",
        title: isLinux
          ? "ax-experiments & Crostini track"
          : "ax-experiments & agent image",
        status:
          (ateLocal.experimentsFound && ateLocal.agentImageBuilt) ||
          expReadyOnLinux
            ? "ok"
            : "warn",
        detail: !ateLocal.experimentsFound
          ? `${exp} not found`
          : ateLocal.agentImageBuilt
            ? `${exp} + ax-agent-local:latest image ready`
            : expReadyOnLinux
              ? `${exp} + crostini/setup-crostini.sh ready`
              : `${exp} present; ax-agent-local:latest image not built`,
        fix: !ateLocal.experimentsFound
          ? `Clone ghchinoy/ax-experiments into ${exp}`
          : ateLocal.agentImageBuilt || expReadyOnLinux
            ? ""
            : "container build -t ax-agent-local:latest swarm/agent-image",
        installTarget: !ateLocal.experimentsFound
          ? "ax-experiments"
          : !ateLocal.agentImageBuilt &&
              !expReadyOnLinux &&
              ateLocal.daemonRunning
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
    const podmanActors = parseMicroVMs(kv.pactors);
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
      ateLocalB: kv.atelocalb === "1",
      axServerB: kv.axserverb === "1",
      podmanAvailable: kv.podman === "1",
      podmanActors,
    };
  }

  async refresh(): Promise<void> {
    ensureStudioBridge();
    this.set({ loading: true });
    try {
      const ateLocalPromise = this.refreshAteLocal();
      const canRunKind =
        this.state.tools.kind && Boolean(this.state.runtime?.runtime);
      const canRunKubectl = this.state.tools.kubectl;
      if (!canRunKind && !canRunKubectl) {
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
        canRunKind
          ? window.studio.run({
              program: "kind",
              args: ["get", "clusters"],
              env,
            })
          : Promise.resolve({ status: 1, stdout: "", stderr: "" }),
        canRunKubectl
          ? window.studio.run({
              program: "kubectl",
              args: ["config", "get-contexts", "-o", "name"],
            })
          : Promise.resolve({ status: 1, stdout: "", stderr: "" }),
      ]);
      const kindNames =
        list.status === 0
          ? list.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => NAME_RE.test(l))
          : [];
      const kubeContexts =
        ctxs.status === 0
          ? ctxs.stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l && isSafeResourceName(l))
          : [];
      const contexts = new Set(kubeContexts);

      const targets: { name: string; context: string; isKind: boolean }[] = [];
      const seenContexts = new Set<string>();
      for (const name of kindNames) {
        const context = `kind-${name}`;
        seenContexts.add(context);
        targets.push({ name, context, isKind: true });
      }
      for (const ctx of kubeContexts) {
        if (
          seenContexts.has(ctx) ||
          ctx === "local" ||
          ctx === "local-podman" ||
          ctx === "local-b"
        ) {
          continue;
        }
        seenContexts.add(ctx);
        if (ctx.startsWith("kind-")) {
          const name = ctx.slice("kind-".length);
          if (NAME_RE.test(name)) {
            targets.push({ name, context: ctx, isKind: true });
          }
        } else {
          targets.push({
            name: shortName(ctx),
            context: ctx,
            isKind: false,
          });
        }
      }

      const clustersList = await Promise.all(
        targets.map(async (target): Promise<Cluster> => {
          const [r, hasTmpKc] = await Promise.all([
            window.studio.run({
              program: "/bin/sh",
              args: ["-c", PROBE, "probe", target.name, target.context],
              env,
            }),
            target.isKind
              ? window.studio.fileExists(
                  `${store.state.settings.repoPath}/.tmp/kubeconfig-${target.name}`,
                )
              : Promise.resolve(false),
          ]);
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
            name: target.name,
            context: target.context,
            isKind: target.isKind,
            reachable: kv.reachable === "1",
            nodes: replicas(kv.nodes),
            version: kv.version ?? "",
            substrate: replicas(kv.substrate),
            substrateCommit: kv.commit ?? "",
            ax: replicas(kv.ax),
            workers: replicas(kv.workers),
            inKubeconfig:
              !target.isKind || contexts.has(target.context) || hasTmpKc,
          };
        }),
      );
      const form = this.state.form.name
        ? this.state.form
        : { ...this.state.form, name: freeName(kindNames) };
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
    if (!NAME_RE.test(name)) {
      throw new Error(`Invalid cluster name "${name}".`);
    }
    const safeWorkers = Math.max(
      1,
      Math.min(8, Math.trunc(Number(workers) || 1)),
    );
    const tmp = `.tmp/kubeconfig-${name}`;
    return [
      "set -e",
      "ORIG=${KUBECONFIG:-$HOME/.kube/config}; ORIG=${ORIG%%:*}",
      'export SUBSTRATE_IMAGE_CACHE_DIR="${SUBSTRATE_IMAGE_CACHE_DIR:-$HOME/.cache/substrate-registry}"',
      'mkdir -p "$SUBSTRATE_IMAGE_CACHE_DIR"',
      `KUBECONFIG="$PWD/${tmp}" KIND_CLUSTER_NAME=${shq(name)} AX_WORKER_REPLICAS=${safeWorkers} AX_SNAPSHOTS_BUCKET=` +
        `${substrateRef ? ` SUBSTRATE_REF=${shq(substrateRef)}` : ""} bash ${SCRIPT}`,
      `printf '\\n==> Adding context kind-%s to %s\\n' ${shq(name)} "$ORIG"`,
      mergeScript(shq(tmp)),
    ].join("\n");
  }

  async create(): Promise<void> {
    const { name, workers, substrateRef } = this.state.form;
    if (!NAME_RE.test(name)) return;
    await this.exec(
      { kind: "create", cluster: name },
      `Create ${name}`,
      this.setupCommand(name, workers, substrateRef.trim()),
    );
  }

  async install(name: string): Promise<void> {
    if (!NAME_RE.test(name)) return;
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
    if (!NAME_RE.test(name)) return;
    await this.exec(
      { kind: "delete", cluster: name },
      `Delete ${name}`,
      `kind delete cluster --name ${shq(name)} && rm -f ${shq(`.tmp/kubeconfig-${name}`)}`,
    );
  }

  async localStackUp(): Promise<boolean> {
    return this.exec(
      { kind: "local-up", cluster: "ate-local" },
      "Start Apple Container stack (ate-local)",
      `bash ${LOCAL_STACK_SCRIPT} up`,
    );
  }

  async localStackMultiUp(): Promise<boolean> {
    return this.exec(
      { kind: "local-up", cluster: "ate-local-b" },
      "Start Dual-Cluster stack (Cluster A Apple + Cluster B Podman)",
      `bash ${LOCAL_STACK_SCRIPT} multi-up`,
    );
  }

  async localStackDown(): Promise<boolean> {
    return this.exec(
      { kind: "local-down", cluster: "ate-local" },
      "Stop Apple Container stack (ate-local)",
      `bash ${LOCAL_STACK_SCRIPT} down`,
    );
  }

  async localStackMultiDown(): Promise<boolean> {
    return this.exec(
      { kind: "local-down", cluster: "ate-local-b" },
      "Stop Dual-Cluster stack (multi-down)",
      `bash ${LOCAL_STACK_SCRIPT} multi-down`,
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
    const validTargets = new Set([
      "all",
      "container-daemon",
      "ax-repo",
      "ate-local-bins",
      "ax-experiments",
      "agent-image",
    ]);
    if (!validTargets.has(target)) return false;
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
    store.setScope({ context: "local" });
    store.setSection("overview");
    await store.loadContexts();
  }

  async openLocalClusterB(): Promise<void> {
    store.setScope({ context: "local-podman" });
    store.setSection("overview");
    await store.loadContexts();
  }

  async runHeroDemo(opts?: {
    attach?: boolean;
    keepStack?: boolean;
    step?: number;
  }): Promise<{ ok: boolean; scoreboard: HeroDemoStep[] }> {
    ensureStudioBridge();
    const info = await window.studio.platform();
    const repo = store.state.settings.repoPath.replace(/^~/, info.home);
    const exp = store.state.settings.experimentsPath.replace(/^~/, info.home);
    const liveScript = `${exp}/hero-demo/run-live.sh`;
    const fallbackScript = `${repo}/hack/hero-demo/run.sh`;
    const hasLive = await window.studio.fileExists(liveScript);

    const flags: string[] = [];
    if (hasLive) {
      if (opts?.attach ?? true) flags.push("--attach");
      if (opts?.keepStack ?? true) flags.push("--keep-stack");
      if (opts?.step && opts.step >= 1 && opts.step <= 5) {
        flags.push("--step", String(opts.step));
      }
    } else if (opts?.step && opts.step >= 1 && opts.step <= 5) {
      flags.push("--step", String(opts.step));
    }

    this.set({
      heroScoreboard: HERO_DEMO_STEPS.map((s) => ({
        ...s,
        status:
          opts?.step && opts.step !== s.step ? "pending" : ("pending" as const),
        note: "",
      })),
    });

    const preClean = [
      "command -v container >/dev/null 2>&1 && container delete --force ate-apple-default-hero-demo-custom-task ate-default-hero-demo-custom-task ate-apple-default-hero-demo-starter-task ate-default-hero-demo-starter-task >/dev/null 2>&1 || true",
      "command -v podman >/dev/null 2>&1 && podman rm -f ate-podman-default-hero-demo-custom-task ate-podman-default-hero-demo-starter-task >/dev/null 2>&1 || true",
    ].join("; ");
    const cmd = hasLive
      ? `${preClean}; AX_REPO=${shq(repo)} AX_CENTRAL_REPO=${shq(`${info.home}/projects/ax-central`)} bash ${shq(liveScript)} ${flags.join(" ")}`
      : `RUN_LIVE_STEPS=1 bash ${shq(fallbackScript)} ${flags.join(" ")}`;

    const ok = await this.exec(
      { kind: "hero-demo", cluster: "hero-demo" },
      "Run AX v0.1 Hero Demo (5/5)",
      cmd,
    );
    await store.refresh(true);
    return { ok, scoreboard: this.state.heroScoreboard };
  }

  private parseHeroLine(line: string): void {
    const startMatch = /^==>\s*\[Step\s*([1-5])\]/.exec(line);
    if (startMatch) {
      const n = Number(startMatch[1]);
      this.set({
        heroScoreboard: this.state.heroScoreboard.map((s) =>
          s.step === n ? { ...s, status: "running" } : s,
        ),
      });
      return;
    }
    const rowMatch =
      /^\s*([1-5])\.\s+([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/.exec(line);
    if (rowMatch) {
      const n = Number(rowMatch[1]);
      const rawStatus = rowMatch[3]!.toUpperCase();
      const note = rowMatch[4]!.trim();
      const status: HeroDemoStep["status"] = rawStatus.includes("PASS")
        ? "pass"
        : rawStatus.includes("STUB")
          ? "stub"
          : "fail";
      this.set({
        heroScoreboard: this.state.heroScoreboard.map((s) =>
          s.step === n ? { ...s, status, note } : s,
        ),
      });
    }
  }

  async addToKubeconfig(name: string): Promise<boolean> {
    if (!NAME_RE.test(name)) return false;
    const tmp = `$TMPDIR/ax-central-kind-${name}.yaml`;
    const ok = await this.exec(
      { kind: "kubeconfig", cluster: name },
      `Add kind-${name} to kubeconfig`,
      [
        "set -e",
        "ORIG=${KUBECONFIG:-$HOME/.kube/config}; ORIG=${ORIG%%:*}",
        `TMPDIR=\${TMPDIR:-/tmp}; kind get kubeconfig --name ${shq(name)} > "${tmp}"`,
        mergeScript(`"${tmp}"`),
        `rm -f "${tmp}"`,
        `printf 'kind-%s added to %s\\n' ${shq(name)} "$ORIG"`,
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
    this.pending.push({
      id: this.lineID++,
      text: text.replace(/\r/g, ""),
      header,
    });
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
        if (op.kind === "hero-demo") {
          this.parseHeroLine(l.line);
        }
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
    if (
      ok &&
      (op.kind === "local-up" || op.kind === "local-reset") &&
      store.state.context === "local"
    ) {
      void store.refresh(true);
    }
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
