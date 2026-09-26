import type { ThreadContainerRunSpec } from './run-spec.ts'
import {
  containerBuildCommand,
  dockerDaemonReachable,
  engineCommand,
  reachableThreadContainerEngines,
  resolveThreadContainerEngine,
  type ThreadContainerEngine,
} from './container-engine.ts'
/**
 * Run one Copse thread inside a disposable, hardened local container
 * (`docs/plans/thread-in-container.md`), under Docker or — on Apple silicon —
 * Apple container. The engine is chosen once per run and every lifecycle call
 * of that run goes to it.
 *
 * The host side owns everything that must not be in the guest: the workspace
 * snapshot going in, the run record coming out, the only network the guest can
 * reach (a per-origin broker), and the container's lifecycle. The guest runs
 * the product's own headless agent host with an unattended run armed, so it
 * never opens a prompt: contained effects run, outward effects queue for
 * review, and the host fetches the result as commits it can inspect before
 * anything is pushed anywhere.
 *
 * Pure builders (`dockerRunArgs`, `buildAttestation`, `parseEgressRule`, …)
 * are separated from the orchestration so the exact flags a run uses are unit
 * tested, not just observed.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { threadContainerResultSchema } from '@shared/container-run-schema.ts'
import { decodeWithSchema } from '@shared/safe-json.ts'
import type {
  ContainerRuntimeAttestation,
  UnattendedRunBudgets,
} from '@shared/types/unattended-run.ts'
import type { ThreadContainerRecord } from '@shared/types/container-run.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { safeJsonParse } from '@shared/safe-json.ts'
import { z } from 'zod'
import { decodeWorkerPhase, type WorkerPhase } from './worker-events.ts'
import { EgressBroker } from './egress-broker.ts'
import {
  findEgressRule,
  formatEgressRule,
  GUEST_NO_PROXY,
  guestEgressProxyUrl,
  parseEgressRule,
  type EgressRule,
} from './egress-rules.ts'
import {
  WORKER_BASE_IMAGE,
  WORKER_DOCKERFILE,
  WORKER_ENTRYPOINT_SH,
  WORKER_PNPM_VERSION,
} from './worker-image-files.ts'
import { containerAcpAgentSpecs } from '@shared/container-acp-agents.ts'
import { removeStagedLogin, stageAgentLogin } from './agent-login.ts'
import { PNPM_STORE_DIR, sanitizedOriginUrl } from './guest-install.ts'
import {
  decodeGuestTranscript,
  relocateGuestPaths,
  relocateTranscript,
} from './guest-transcript.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { runSerialized } from '@copse/thread-store/write-queue.ts'
import { snapshotWorkingTree } from '../git-snapshot.mts'
import { providerEndpointUrl, type ProviderDescription } from '../providers/provider-description.ts'

const execFileAsync = promisify(execFile)

export const WORKER_IMAGE = 'copse-worker:local'
export const WORKER_UID = 1001
export const GUEST_RUN_DIR = '/run/copse'
export const GUEST_WORKSPACE = '/workspace/repo'
/** The worker's home in the guest: on the run's volume, created by the worker at start. */
export const GUEST_HOME = '/workspace/home'
export const CARRY_IN_REF_PREFIX = 'refs/copse/carry-in/'
export const CARRY_OUT_REF_PREFIX = 'refs/copse/runs/'
export const MANAGED_LABEL = 'dev.copse.managed'
/** Identifies which worker build an image was made from; see {@link workerImageFingerprint}. */
export const FINGERPRINT_LABEL = 'dev.copse.worker-fingerprint'
export const RUNTIME_LABEL = 'dev.copse.runtime'
export const SANDBOX_RUNTIME_PACKAGE = '@anthropic-ai/sandbox-runtime'

/** What the CLI or a test asks for. */
export type { ThreadContainerRecord } from '@shared/types/container-run.ts'

export interface ThreadContainerRequest {
  /** Local git checkout to carry in. */
  workspace: string
  /**
   * The desktop thread the run belongs to, written to the record so a
   * follow-up or continuation from disk can check the run is this thread's.
   * The guest's own thread id is private to the guest and never this.
   */
  threadId?: string
  prompt: string
  /** Product model id as the settings UI would store it, e.g. `local:qwen`. */
  model: string
  /**
   * The provider as the guest should build it (`describeProvider`, adapted
   * for the guest by `resolveContainerProvider`): protocol, endpoint and the
   * user's tuned parameters, without the key. Its endpoint's origin must be
   * in the egress allowlist; that is the only route out of the guest. Omit
   * for an ACP run, which brings its own agent.
   */
  provider?: ProviderDescription
  /** What the guest trims history against; the desktop's own answer for the model. */
  contextWindow?: number
  /** Environment variable on the host holding the provider key; the value is passed, never the name. */
  apiKeyEnv?: string
  /**
   * Run the thread under an external ACP agent instead of Copse's own loop
   * (`docs/plans/thread-in-container.md`, "Agent models in the guest"). The
   * agent binary must be in the image; the run's one key reaches it through
   * `keyEnvName` in its environment. Its origins must be in the allowlist.
   */
  acp?: ThreadContainerAcpHarness
  /**
   * Install the checkout's dependencies in the guest before the agent starts
   * (decision A9): the worker runs the lockfile's install with the run's proxy.
   * The caller admits the package registry in the allowlist when it sets this.
   */
  installDependencies?: boolean
  /**
   * Carry in this ref instead of a snapshot of the checkout (decision A14):
   * an earlier run's carry-out, so the guest continues from that run's
   * commits without the desktop's checkout having moved.
   */
  carryInRef?: string
  budgets: UnattendedRunBudgets
  /** `host:port` and `*.suffix:port` rules the broker admits. Nothing else is reachable. */
  egressAllowlist: string[]
  /**
   * Guest-facing origin name → `addr` or `addr:port` the host dials instead, for
   * names only the guest knows (a scripted origin on loopback playing a real one).
   */
  egressResolve?: Record<string, string>
  image?: string
  /**
   * The engine the caller resolved for this run ({@link assertThreadContainerEngine});
   * resolved here when absent. It is the engine for the whole run: the image
   * it was built on, the container, and the teardown.
   */
  engine?: ThreadContainerEngine
  /** Where run directories live; defaults to `<COPSE_DIR>/runtimes`. */
  runtimesDir?: string
  maxSteps?: number
}

/** An ACP agent to run the thread under, and the variable its key arrives in. */
export interface ThreadContainerAcpHarness {
  /**
   * The agent as the guest should register it. Carries no credentials and no
   * user `env`: the only variable the agent is given is `keyEnvName`, filled
   * in by the guest from the run's key (decision A1).
   */
  agent: AcpAgentConfig
  /** The agent's own key variable, e.g. `ANTHROPIC_API_KEY`. */
  keyEnvName: string
  /**
   * Carry the user's desktop sign-in in instead of a key (decision A1′): the
   * home-relative files to copy. The host stages the ones that exist into the
   * run directory and the guest restores them into its own home.
   */
  login?: { files: string[] }
}

/** The spec the guest reads from `run.json`. Contains no secrets. */
export type { ThreadContainerRunSpec } from './run-spec.ts'

/**
 * The profile root, resolved here rather than imported: this module runs under
 * plain Node (the CLI), which cannot load the main process's `.ts` modules. It
 * mirrors `copseDataRoot()` in `src/main/services/storage/copse-paths.ts`.
 */
function copseDataRoot(): string {
  const configured = process.env['COPSE_DIR']?.trim()
  return configured && configured.length > 0 ? configured : join(homedir(), '.copse')
}

export function newRuntimeId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/** A concrete `host:port` a provider URL resolves to, checked against the rules. */
export interface ProviderOrigin {
  host: string
  port: number
}

/** The origin a provider URL resolves to, so it can be checked against the allowlist. */
export function providerOrigin(url: string): ProviderOrigin {
  const parsed = new URL(url)
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return { host: parsed.hostname, port }
}

export interface ContainerRunInput {
  /** The engine this run was resolved to; every flag below is spelled for it. */
  engine: ThreadContainerEngine
  runtimeId: string
  image: string
  runDir: string
  egress: EgressRule[]
  /**
   * The run's proxy token (decision A7): carried on the proxy URL the guest is
   * started with, required by the guest proxy on every request, withheld from
   * shell children by the worker. Null when there is no egress at all.
   */
  egressToken: string | null
  /**
   * Mount the host's shared pnpm store for the install step (decision A12).
   * Docker only: an Apple container volume attaches to one container at a
   * time, so a store shared by concurrent runs cannot exist there.
   */
  sharedStore: boolean
  apiKeyEnv: string | null
  memoryLimit: string
  pidsLimit: number
  cpus: number
}

/**
 * The `docker create` argv for one run. Every hardening flag the attestation
 * later claims is set here and nowhere else, so the two cannot drift.
 */
export function dockerRunArgs(input: ContainerRunInput): string[] {
  if (input.engine !== 'docker') throw new Error(`dockerRunArgs called for ${input.engine}`)
  return [
    // Created now, started attached (`docker start --attach --interactive`):
    // the container's stdin and stdout are the egress link (`egress-link.ts`),
    // its stderr the run's log, and none of it needs a socket in a bind
    // mount, which Docker Desktop's file sharing cannot carry into the VM.
    'create',
    '--interactive',
    '--name',
    containerName(input.runtimeId),
    '--label',
    `${MANAGED_LABEL}=1`,
    '--label',
    `${RUNTIME_LABEL}=${input.runtimeId}`,
    '--init',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    // Docker's default seccomp and AppArmor profiles stay on. They were once
    // relaxed so bubblewrap could nest a per-command sandbox inside the guest;
    // the container is the sandbox now (decision A7), so the boundary that
    // matters keeps its syscall filter.
    `--pids-limit=${String(input.pidsLimit)}`,
    `--memory=${input.memoryLimit}`,
    `--cpus=${String(input.cpus)}`,
    `--user=${String(WORKER_UID)}:${String(WORKER_UID)}`,
    // tmpfs mounts are root-owned by default regardless of the image; the
    // worker uid must own its scratch, workspace and home.
    // `exec`: Docker's tmpfs default is noexec, and a project's own tests
    // write helper scripts to /tmp and run them (seen in the first full run).
    '--tmpfs=/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777',
    // The workspace is a per-run Docker volume, not a tmpfs: a project's
    // node_modules runs to gigabytes, and tmpfs pages are charged to the
    // container's memory limit. The volume lives on the daemon's own disk,
    // never on a host path, is created empty for this run and removed with
    // the container. The image owns /workspace as the worker uid, which a
    // fresh volume inherits.
    `--mount=type=volume,source=${workspaceVolumeName(input.runtimeId)},target=/workspace,volume-nocopy=false`,
    // The shared pnpm store, only for a run that installs: a nested mount
    // inside the fresh workspace, owned by the worker uid because the image
    // has the directory (decision A12).
    ...(input.sharedStore
      ? [
          `--mount=type=volume,source=${PNPM_STORE_VOLUME},target=${PNPM_STORE_DIR},volume-nocopy=false`,
        ]
      : []),
    '--network=none',
    '--stop-timeout=30',
    ...guestRunArgs(input),
  ]
}

/**
 * The `container create` argv for one run under Apple container. The same
 * guest as {@link dockerRunArgs}, hardened with the flags Apple container has;
 * where it has none, the property is enforced another way and the attestation
 * says which (`docs/plans/thread-in-container.md`, "Apple container as the
 * host engine"):
 *
 * - no-new-privileges: no flag, so the image's entrypoint sets it (setpriv)
 *   and the image carries no setuid binary; the worker checks it is on.
 * - pids limit: no cgroup flag, so `RLIMIT_NPROC` on the worker uid, the only
 *   uid running in the guest's own kernel.
 * - seccomp/AppArmor: none — the boundary is the per-container VM.
 * - volume ownership: a fresh volume is root-owned and does not inherit the
 *   image's `/workspace`, so {@link appleVolumePrepareArgs} hands it to the
 *   worker uid first.
 *
 * Everything else is the same flag in Apple's spelling, and all of it is read
 * back from `container inspect` before the run starts ({@link appleConfigShortfall}).
 */
export function appleCreateArgs(input: ContainerRunInput): string[] {
  if (input.engine !== 'apple') throw new Error(`appleCreateArgs called for ${input.engine}`)
  if (input.sharedStore) {
    throw new Error('Apple container cannot share the pnpm store volume between runs')
  }
  const pids = String(input.pidsLimit)
  return [
    // Created now, started attached, exactly as under Docker: the container's
    // stdin and stdout are the egress link, its stderr the run's log.
    'create',
    '--interactive',
    '--name',
    containerName(input.runtimeId),
    '--label',
    `${MANAGED_LABEL}=1`,
    '--label',
    `${RUNTIME_LABEL}=${input.runtimeId}`,
    '--init',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--ulimit',
    `nproc=${pids}:${pids}`,
    '--memory',
    input.memoryLimit,
    '--cpus',
    String(input.cpus),
    '--user',
    `${String(WORKER_UID)}:${String(WORKER_UID)}`,
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777',
    '--mount',
    `type=volume,source=${workspaceVolumeName(input.runtimeId)},target=/workspace`,
    // No interface but loopback. Measured: the gateway, the host and the
    // internet are all ENETUNREACH and DNS fails, where the default network
    // reaches all three.
    '--network',
    'none',
    ...guestRunArgs(input),
  ]
}

/** The create argv for the run's engine. */
export function containerCreateArgs(input: ContainerRunInput): string[] {
  return input.engine === 'apple' ? appleCreateArgs(input) : dockerRunArgs(input)
}

/**
 * Hand a fresh Apple container volume to the worker uid. Apple formats each
 * volume as an empty, root-owned ext4 image (and ignores `--opt uid=`), so
 * without this the worker could not write its own workspace. A throwaway
 * container does it: root, but with every capability dropped except
 * `CAP_CHOWN`, no network, a read-only root, and nothing mounted but the new
 * volume.
 */
export function appleVolumePrepareArgs(input: ContainerRunInput): string[] {
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CAP_CHOWN',
    '--user',
    '0:0',
    '--mount',
    `type=volume,source=${workspaceVolumeName(input.runtimeId)},target=/workspace`,
    '--entrypoint',
    'chown',
    input.image,
    `${String(WORKER_UID)}:${String(WORKER_UID)}`,
    '/workspace',
  ]
}

/** Mounts, environment and image: the part of the create argv both engines share. */
function guestRunArgs(input: ContainerRunInput): string[] {
  const args = [
    '--volume',
    `${input.runDir}:${GUEST_RUN_DIR}:ro`,
    '--volume',
    `${join(input.runDir, 'state')}:${GUEST_RUN_DIR}/state:rw`,
    '--volume',
    `${join(input.runDir, 'out')}:${GUEST_RUN_DIR}/out:rw`,
    '--env',
    `COPSE_DIR=${GUEST_RUN_DIR}/state`,
    // The worker's home lives on the run's volume too, not on a tmpfs: an
    // install's caches (Electron's download, a tool's own cache) filled a
    // 256 MB one on the first real e2e-capable install. The worker creates
    // it, private to itself, before anything else runs.
    '--env',
    `HOME=${GUEST_HOME}`,
    // Nothing in the guest can fetch a browser from its vendor's CDN (those
    // hosts are never admitted), so the postinstall hooks that try are told
    // not to, here as well as for the worker's own install step. Electron is
    // not on this list: it comes from GitHub releases, which an installing
    // run admits (A11).
    '--env',
    'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1',
    '--env',
    'PUPPETEER_SKIP_DOWNLOAD=1',
    '--env',
    'CYPRESS_INSTALL_BINARY=0',
  ]
  if (input.egress.length > 0) {
    // One link to the host over the container's stdio, and a loopback proxy
    // in the guest that opens a stream on it per request. Every client in the
    // guest is pointed at that proxy: Node's own
    // fetch (the worker's SDK calls) through NODE_USE_ENV_PROXY, and any child
    // that honours the conventional variables — git, curl, an agent CLI. Both
    // spellings, because the tools are split on which one they read. NO_PROXY
    // names loopback only: nothing else is reachable direct, and the guest's
    // own listeners (the ACP native-tools bridge) must not be sent to the
    // proxy, which would refuse them.
    // The URL carries the run's token: Node's env-proxy dispatcher reads it
    // once at startup, after which the worker blanks these variables so the
    // shell children it spawns inherit no way onto the proxy (decision A7).
    const proxy = guestEgressProxyUrl(input.egressToken)
    args.push(
      '--env',
      'COPSE_EGRESS=stdio',
      '--env',
      `COPSE_EGRESS_TOKEN=${input.egressToken ?? ''}`,
      '--env',
      `HTTPS_PROXY=${proxy}`,
      '--env',
      `HTTP_PROXY=${proxy}`,
      '--env',
      `https_proxy=${proxy}`,
      '--env',
      `http_proxy=${proxy}`,
      '--env',
      `NO_PROXY=${GUEST_NO_PROXY}`,
      '--env',
      `no_proxy=${GUEST_NO_PROXY}`,
      '--env',
      'NODE_USE_ENV_PROXY=1',
      // Node's env-proxy dispatcher announces itself as experimental on every
      // process that loads it — the worker and each Node-based agent — and the
      // run's log is where the user reads that. It is the mechanism the run
      // relies on, chosen deliberately; the notice is noise here.
      '--env',
      'NODE_OPTIONS=--disable-warning=UNDICI-EHPA',
    )
  }
  // The provider key is the one secret the guest holds, scoped to this run and
  // passed by value so the *name* of the host variable never leaks either.
  if (input.apiKeyEnv) args.push('--env', input.apiKeyEnv)
  args.push(input.image)
  return args
}

export function containerName(runtimeId: string): string {
  return `copse-${runtimeId}`
}

/** The run's workspace volume: created before the container, removed after it. */
export function workspaceVolumeName(runtimeId: string): string {
  return `copse-ws-${runtimeId}`
}

/**
 * The pnpm store every installing run shares (decision A12): one volume per
 * host, mounted beside a fresh workspace, so the second install of a project
 * links from the store instead of fetching a thousand packages again. pnpm
 * checks each package against the lockfile's integrity hash as it links, so
 * a stale or tampered store entry is rejected rather than used. Labelled by
 * role, not as a managed runtime, so the orphan sweep leaves it alone.
 */
export const PNPM_STORE_VOLUME = 'copse-pnpm-store'
export const STORE_ROLE_LABEL = 'dev.copse.role'

/**
 * Create the shared store if it does not exist; creating an existing volume
 * is a no-op. Docker only (see {@link ContainerRunInput.sharedStore}).
 */
export async function ensurePnpmStoreVolume(): Promise<void> {
  await runEngine('docker', [
    'volume',
    'create',
    '--label',
    `${STORE_ROLE_LABEL}=pnpm-store`,
    PNPM_STORE_VOLUME,
  ])
}

/** Remove the shared store; the next installing run starts it again from nothing. */
export async function forgetPnpmStoreVolume(): Promise<'removed' | 'already-gone'> {
  try {
    await runEngine('docker', ['volume', 'inspect', PNPM_STORE_VOLUME])
  } catch {
    return 'already-gone'
  }
  await runEngine('docker', ['volume', 'rm', PNPM_STORE_VOLUME])
  return 'removed'
}

export function buildAttestation(
  input: ContainerRunInput,
  imageDigest: string | undefined,
): ContainerRuntimeAttestation {
  const common = {
    runtimeId: input.runtimeId,
    image: input.image,
    ...(imageDigest !== undefined ? { imageDigest } : {}),
    user: WORKER_UID,
    readOnlyRootfs: true,
    capDropAll: true,
    noNewPrivileges: true,
    pidsLimit: input.pidsLimit,
    memoryLimit: input.memoryLimit,
    network: input.egress.length > 0 ? 'brokered' : 'none',
    perCommandNetwork: input.egressToken !== null ? 'token-gated' : 'none',
    egressAllowlist: input.egress.map(formatEgressRule),
    hostMounts: [GUEST_RUN_DIR, `${GUEST_RUN_DIR}/state`, `${GUEST_RUN_DIR}/out`],
  } satisfies Omit<ContainerRuntimeAttestation, 'engine' | 'isolation' | 'processLimit'>
  // What differs is how the engine isolates, never what the guest is allowed:
  // see ENGINE_BAR in `security/runtime-containment.ts`.
  return input.engine === 'apple'
    ? {
        ...common,
        engine: 'apple',
        isolation: 'vm',
        securityProfiles: 'none',
        processLimit: 'rlimit-nproc',
      }
    : {
        ...common,
        engine: 'docker',
        isolation: 'shared-kernel',
        securityProfiles: 'default',
        processLimit: 'cgroup-pids',
      }
}

// ---------------------------------------------------------------------------
// Workspace carry-in / carry-out (git-first; no host path enters the guest)
// ---------------------------------------------------------------------------

/** The checkout's `origin` URL, or null when it has none. */
async function originUrlOf(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['remote', 'get-url', 'origin'])
  } catch {
    return null
  }
}

/**
 * Run git and return its stdout. Asynchronous on purpose: this runs in
 * Electron's main process, and the snapshot of a large working tree plus the
 * bundle of its whole history take tens of seconds — done synchronously they
 * froze the entire app until the container started (A14). stderr is captured,
 * not inherited: git's own account of a failure belongs in the thrown error,
 * where the record and the dialog can show it.
 */
async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.trim()
}

/**
 * Snapshot the working tree (staged + unstaged + untracked, .gitignore
 * respected) into a commit without touching HEAD or the real index. Returns
 * HEAD when the tree is clean.
 */
export function createSnapshotCommit(cwd: string): Promise<{ sha: string; dirty: boolean }> {
  return snapshotWorkingTree((args, env) => git(cwd, args, env), {
    message: 'copse: working-tree snapshot for a container run',
    identity: { name: 'copse', email: 'copse@copse.invalid' },
  })
}

/** Bundle the snapshot under a run-scoped ref so the guest can fetch it by name. */
export async function writeCarryInBundle(
  workspace: string,
  runtimeId: string,
  bundlePath: string,
  fromRef?: string,
): Promise<{ ref: string; sha: string; dirty: boolean }> {
  const snapshot =
    fromRef === undefined
      ? await createSnapshotCommit(workspace)
      : {
          sha: await git(workspace, ['rev-parse', '--verify', `${fromRef}^{commit}`]),
          dirty: false,
        }
  const ref = `${CARRY_IN_REF_PREFIX}${runtimeId}`
  await git(workspace, ['update-ref', ref, snapshot.sha])
  try {
    await git(workspace, ['bundle', 'create', bundlePath, ref])
  } finally {
    await git(workspace, ['update-ref', '-d', ref])
  }
  return { ref, sha: snapshot.sha, dirty: snapshot.dirty }
}

/** Fetch the guest's commits back under `refs/copse/runs/<id>`; the host never pushes. */
export async function fetchCarryOut(
  workspace: string,
  runtimeId: string,
  bundlePath: string,
): Promise<string> {
  const ref = `${CARRY_OUT_REF_PREFIX}${runtimeId}`
  await git(workspace, ['fetch', '--no-tags', bundlePath, `refs/heads/work:${ref}`])
  return ref
}

export interface CarryOutAdoption {
  /** `<short sha> <subject>` of each commit cherry-picked, oldest first. */
  applied: string[]
  /** Commits on the ref whose change HEAD already had; left alone. */
  alreadyApplied: number
}

/**
 * Follow up on a run in the thread's own checkout (decision A13): apply the
 * guest's commits — the ones after the carry-in base on the carry-out ref —
 * onto HEAD, so the thread's next turn, attended, starts from where the run
 * left off. A cherry-pick rather than a merge: the base may be a snapshot
 * commit of a dirty tree the user still has, and a merge would bring that
 * snapshot in as a commit of its own. `git cherry` decides what is still
 * missing by patch id, so applying twice is a no-op with a count, not a pile
 * of duplicate commits. A conflict aborts the whole pick and is reported; the
 * checkout is left as it was.
 */
export function adoptCarryOut(
  workspace: string,
  ref: string,
  base: string,
): Promise<CarryOutAdoption> {
  // One pick at a time per checkout, the whole check-and-pick as one turn.
  // Two follow-ups pressed together would otherwise both run against the
  // same index, and the one that failed would `cherry-pick --abort` the
  // other's pick as well as its own.
  return runSerialized(`carry-out-adoption:${resolve(workspace)}`, () =>
    adoptOnce(workspace, ref, base),
  )
}

async function adoptOnce(workspace: string, ref: string, base: string): Promise<CarryOutAdoption> {
  const dirty = await git(workspace, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty.length > 0) {
    throw new Error(
      'The checkout has uncommitted changes to tracked files; commit or stash them before applying the run',
    )
  }
  const cherry = await git(workspace, ['cherry', 'HEAD', ref, base])
  const lines = cherry.length === 0 ? [] : cherry.split('\n')
  const pending = lines.filter((line) => line.startsWith('+ ')).map((line) => line.slice(2))
  const alreadyApplied = lines.filter((line) => line.startsWith('- ')).length
  if (pending.length === 0) return { applied: [], alreadyApplied }
  try {
    await git(workspace, ['cherry-pick', '--no-edit', '--allow-empty-message', ...pending])
  } catch (error) {
    try {
      await git(workspace, ['cherry-pick', '--abort'])
    } catch {
      // Nothing to abort, or the abort itself failed: the pick error is the one to report.
    }
    throw new Error(
      `Could not apply the run's commits: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const applied: string[] = []
  for (const sha of pending)
    applied.push(await git(workspace, ['log', '-1', '--format=%h %s', sha]))
  return { applied, alreadyApplied }
}

/**
 * What a continuation needs from an earlier run (decision A14): the ref its
 * commits are on (null when it made none: the follow-up then starts from a
 * fresh snapshot, and the prompt alone is the continuity), what it was asked
 * and what it reported, from the run's files on disk so a run an earlier app
 * session made can be continued too. Null when there is no such record.
 */
export function loadRunForContinuation(
  runtimeId: string,
  runtimesDir = join(copseDataRoot(), 'runtimes'),
): { threadId: string; ref: string | null; prompt: string; finalText: string } | null {
  if (!/^[a-z0-9-]+$/i.test(runtimeId)) return null
  const record = readJsonFile(join(runtimesDir, runtimeId, 'record.json'), (value) =>
    isRecord(value) ? value : null,
  )
  if (!record) return null
  const threadId = record['threadId']
  if (typeof threadId !== 'string') return null
  const carryOut = record['carryOut']
  const ref = isRecord(carryOut) ? carryOut['ref'] : null
  const spec = readJsonFile(join(runtimesDir, runtimeId, 'run.json'), (value) =>
    isRecord(value) ? value : null,
  )
  const prompt = spec?.['prompt']
  const result = record['result']
  const finalText = isRecord(result) ? result['finalText'] : undefined
  return {
    threadId,
    ref: typeof ref === 'string' ? ref : null,
    prompt: typeof prompt === 'string' ? prompt : '',
    finalText: typeof finalText === 'string' ? finalText : '',
  }
}

/**
 * What a follow-up needs from a run's record on disk, for a run this app
 * session did not start: the record is the durable artefact, the in-memory
 * run is not. Null when there is no such record or it fetched no commits.
 */
export function loadCarryOutForAdoption(
  runtimeId: string,
  runtimesDir = join(copseDataRoot(), 'runtimes'),
): { threadId: string; ref: string; base: string } | null {
  if (!/^[a-z0-9-]+$/i.test(runtimeId)) return null
  const record = readJsonFile(join(runtimesDir, runtimeId, 'record.json'), (value) =>
    isRecord(value) ? value : null,
  )
  if (!record) return null
  const carryOut = record['carryOut']
  const carryIn = record['carryIn']
  if (!isRecord(carryOut) || !isRecord(carryIn)) return null
  const threadId = record['threadId']
  const ref = carryOut['ref']
  const base = carryIn['sha']
  if (typeof threadId !== 'string' || typeof ref !== 'string' || typeof base !== 'string') {
    return null
  }
  return { threadId, ref, base }
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

/**
 * Identity of the worker build an image would be made from: the guest bundle,
 * the two files the image is assembled from, the uid it runs as, and the
 * sandbox-runtime version staged beside the bundle.
 *
 * An image is reused only when its `dev.copse.worker-fingerprint` label matches
 * this. Tag existence alone is not enough: `copse-worker:local` survives app
 * upgrades, so a user who updates Copse would otherwise keep running the
 * previous worker — including its permission behaviour — until they deleted the
 * image by hand.
 */
export function workerBuildFingerprint(options: BuildImageOptions = {}): string {
  const bundle = options.workerBundle ?? defaultWorkerBundlePath()
  const hash = createHash('sha256')
  hash.update('copse-worker-image-v1\n')
  hash.update(`uid:${String(WORKER_UID)}\n`)
  hash.update(`base:${options.baseImage ?? WORKER_BASE_IMAGE}\n`)
  // The agents baked in, by pinned version: bumping one rebuilds the image.
  hash.update(`acp-agents:${(options.acpAgents ?? containerAcpAgentSpecs()).join(' ')}\n`)
  hash.update(`pnpm:${options.pnpmVersion ?? WORKER_PNPM_VERSION}\n`)
  hash.update(WORKER_DOCKERFILE)
  hash.update(WORKER_ENTRYPOINT_SH)
  hash.update(readFileSync(bundle))
  try {
    const runtimeDir = installedPackageDir(dirname(bundle), SANDBOX_RUNTIME_PACKAGE)
    const manifest: unknown = JSON.parse(readFileSync(join(runtimeDir, 'package.json'), 'utf8'))
    hash.update(`sandbox-runtime:${isRecord(manifest) ? String(manifest['version']) : '?'}\n`)
  } catch {
    // A runtime we cannot locate is a build-time failure, not a hashing one.
  }
  return hash.digest('hex')
}

/** The worker build an existing image was made from, or null when it has none. */
export async function workerImageFingerprint(
  image: string,
  engine: ThreadContainerEngine = 'docker',
): Promise<string | null> {
  try {
    if (engine === 'apple') {
      return appleImageLabel(
        await runEngine('apple', ['image', 'inspect', image]),
        FINGERPRINT_LABEL,
      )
    }
    const label = await runEngine('docker', [
      'image',
      'inspect',
      '--format',
      `{{index .Config.Labels "${FINGERPRINT_LABEL}"}}`,
      image,
    ])
    return label.length > 0 && label !== '<no value>' ? label : null
  } catch {
    return null
  }
}

/**
 * `container image inspect`: an index whose digest identifies the image, with
 * one variant per platform carrying the image config (labels included).
 */
const appleImageInspectSchema = z
  .array(
    z.object({
      configuration: z.object({ descriptor: z.object({ digest: z.string().min(1) }) }),
      variants: z.array(
        z.object({
          config: z
            .object({
              config: z.object({ Labels: z.record(z.string(), z.string()).nullish() }).nullish(),
            })
            .nullish(),
        }),
      ),
    }),
  )
  .min(1)

/** A label on any platform variant of an inspected Apple container image, or null. */
export function appleImageLabel(inspectJson: string, label: string): string | null {
  const images = safeJsonParse(inspectJson, decodeWithSchema(appleImageInspectSchema))
  for (const variant of images?.[0]?.variants ?? []) {
    const value = variant.config?.config?.Labels?.[label]
    if (value !== undefined && value.length > 0) return value
  }
  return null
}

/** The digest of an inspected Apple container image, or undefined. */
export function appleImageDigest(inspectJson: string): string | undefined {
  const images = safeJsonParse(inspectJson, decodeWithSchema(appleImageInspectSchema))
  return images?.[0]?.configuration.descriptor.digest
}

export interface BuildImageOptions {
  /** The engine to build with; resolved when absent. Images are per engine. */
  engine?: ThreadContainerEngine
  image?: string
  baseImage?: string
  /** Docker build `--network`; some sandboxes need `host` for apt. Apple container has none. */
  buildNetwork?: string
  /**
   * `package@version` specs of the ACP agents to bake in. Defaults to the
   * key-capable catalogue agents (`container-acp-agents.ts`); a test that
   * needs no agent passes `[]` and gets a smaller, faster build.
   */
  acpAgents?: readonly string[]
  /** The pnpm baked in for a project's install; defaults to {@link WORKER_PNPM_VERSION}. */
  pnpmVersion?: string
  contextDir?: string
  /**
   * The bundled guest entry. Defaults to the standalone bundle the build emits
   * beside the main bundle (`dist/main/thread-container-worker.cjs`); the CLI
   * and the integration test bundle their own and pass the path.
   */
  workerBundle?: string
}

/** Where the build leaves the guest bundle; see `scripts/main-bundles.mts`. */
export function defaultWorkerBundlePath(): string {
  return join(__dirname, 'thread-container-worker.cjs')
}

/**
 * The directory of an installed package, found from its resolvable entry
 * rather than `<name>/package.json` (which a package's `exports` map may not
 * expose). Walks up from the entry to the nearest `package.json` of that name.
 */
function installedPackageDir(fromDir: string, name: string): string {
  const req = createRequire(join(fromDir, 'noop.js'))
  let dir = dirname(req.resolve(name))
  for (let depth = 0; depth < 12; depth++) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      if (isRecord(parsed) && parsed['name'] === name) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Cannot locate the installed package ${name} from ${fromDir}`)
}

/**
 * Copy the sandbox runtime and its transitive dependencies from the app's own
 * `node_modules` into the image context. The guest needs no other package: the
 * worker bundle carries everything else, and the runtime stays external only
 * because it locates helper files by path at run time. No package manager runs
 * here, so a packaged app with no `npm` on the host builds the image too.
 */
export function stageSandboxRuntime(contextDir: string, fromDir = __dirname): string[] {
  const staged: string[] = []
  const queue: Array<{ name: string; fromDir: string }> = [
    { name: SANDBOX_RUNTIME_PACKAGE, fromDir },
  ]
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || staged.includes(next.name)) continue
    const dir = installedPackageDir(next.fromDir, next.name)
    const target = join(contextDir, 'node_modules', ...next.name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(dir, target, {
      recursive: true,
      dereference: true,
      // A package's own nested node_modules are copied by the dependency walk
      // below from wherever they really resolve; only look *below* the package
      // (its own path is inside a node_modules tree).
      filter: (source) => !relative(dir, source).split(sep).includes('node_modules'),
    })
    staged.push(next.name)
    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const dependencies = isRecord(manifest) ? manifest['dependencies'] : undefined
    if (isRecord(dependencies)) {
      for (const dependency of Object.keys(dependencies)) {
        queue.push({ name: dependency, fromDir: dir })
      }
    }
  }
  return staged
}

/**
 * Where the image context is staged. Apple container 1.4.1's build drops every
 * file below the top level of a context under `/private` — the resolved
 * `os.tmpdir()` (`/private/var/folders/…`) and `/private/tmp` alike — while
 * the same context under the home directory builds whole (measured from an
 * unsandboxed shell). The image then lacked the staged sandbox runtime and
 * the worker died at load, so Apple builds stage under the profile instead.
 */
function defaultBuildContextDir(engine: ThreadContainerEngine): string {
  return engine === 'apple'
    ? join(copseDataRoot(), 'cache', 'worker-context')
    : join(tmpdir(), 'copse-worker-context')
}

/**
 * Assemble the build context and build the worker image. The context carries
 * only the bundled worker, the sandbox runtime, and the entrypoint — never the
 * repository, never the app's node_modules, never a credential.
 */
export async function buildWorkerImage(options: BuildImageOptions = {}): Promise<string> {
  const engine = options.engine ?? (await assertThreadContainerEngine())
  const image = options.image ?? WORKER_IMAGE
  const workerBundle = options.workerBundle ?? defaultWorkerBundlePath()
  if (!existsSync(workerBundle)) {
    throw new Error(
      `Container worker bundle missing at ${workerBundle}; run \`pnpm run build\` (it is a standalone main bundle)`,
    )
  }
  const fingerprint = workerBuildFingerprint({ ...options, workerBundle })
  const contextDir = resolve(options.contextDir ?? defaultBuildContextDir(engine))
  rmSync(contextDir, { recursive: true, force: true })
  mkdirSync(contextDir, { recursive: true })
  cpSync(workerBundle, join(contextDir, 'worker.cjs'))
  writeFileSync(join(contextDir, 'entrypoint.sh'), WORKER_ENTRYPOINT_SH, { mode: 0o755 })
  writeFileSync(join(contextDir, 'Dockerfile'), WORKER_DOCKERFILE)
  writeFileSync(
    join(contextDir, 'package.json'),
    `${JSON.stringify({ name: 'copse-worker-runtime', private: true }, null, 2)}\n`,
  )
  stageSandboxRuntime(contextDir)
  const build = containerBuildCommand(engine, {
    file: join(contextDir, 'Dockerfile'),
    tag: image,
    context: contextDir,
    labels: { [FINGERPRINT_LABEL]: fingerprint },
    ...(options.buildNetwork ? { network: options.buildNetwork } : {}),
    buildArgs: {
      BASE_IMAGE: options.baseImage ?? WORKER_BASE_IMAGE,
      ACP_AGENTS: (options.acpAgents ?? containerAcpAgentSpecs()).join(' '),
      PNPM_VERSION: options.pnpmVersion ?? WORKER_PNPM_VERSION,
      WORKER_UID: String(WORKER_UID),
    },
  })
  await runEngine(engine, build.args)
  return image
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function runEngine(engine: ThreadContainerEngine, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(engineCommand(engine), args, {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.trim()
}

export function dockerAvailable(): Promise<boolean> {
  return dockerDaemonReachable()
}

/** Whether Apple container's services answer; the Apple twin of {@link dockerAvailable}. */
export async function appleContainerAvailable(): Promise<boolean> {
  return (await reachableThreadContainerEngines()).includes('apple')
}

/**
 * The engine this run will use, or a readable refusal before anything is
 * built: Docker when its daemon answers, else Apple container on Apple
 * silicon, unless `COPSE_CONTAINER_ENGINE` names one (see
 * {@link resolveThreadContainerEngine}). Called once per run; the answer is
 * passed to every later step instead of being asked again.
 */
export function assertThreadContainerEngine(): Promise<ThreadContainerEngine> {
  return resolveThreadContainerEngine()
}

async function imageDigest(
  image: string,
  engine: ThreadContainerEngine,
): Promise<string | undefined> {
  try {
    if (engine === 'apple') {
      return appleImageDigest(await runEngine('apple', ['image', 'inspect', image]))
    }
    const out = await runEngine('docker', ['image', 'inspect', '--format', '{{.Id}}', image])
    return out || undefined
  } catch {
    return undefined
  }
}

/** The engine's answer for a container or volume that does not exist. */
function isNotFound(engine: ThreadContainerEngine, error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const text = [Reflect.get(error, 'stderr'), Reflect.get(error, 'message')]
    .filter((part) => typeof part === 'string')
    .join('\n')
  return engine === 'apple'
    ? /not found/i.test(text)
    : /no such (?:container|object|volume)/i.test(text)
}

/**
 * Idempotent: removing a container that is already gone is success, reported
 * distinctly so a reconciliation sweep can tell "I removed it" from "it was
 * already gone" (`docker rm --force` itself no longer distinguishes the two).
 */
export async function teardownRuntime(
  runtimeId: string,
  engine?: ThreadContainerEngine,
): Promise<'removed' | 'already-gone' | 'failed'> {
  // A run this session did not start (a supervisor task from an earlier one)
  // may be on either engine; ask every engine that is up.
  if (engine === undefined) {
    const engines = await reachableThreadContainerEngines()
    if (engines.length === 0) return 'failed'
    const outcomes = await Promise.all(engines.map((each) => teardownRuntime(runtimeId, each)))
    if (outcomes.includes('failed')) return 'failed'
    return outcomes.includes('removed') ? 'removed' : 'already-gone'
  }
  return engine === 'apple' ? teardownAppleRuntime(runtimeId) : teardownDockerRuntime(runtimeId)
}

async function teardownDockerRuntime(
  runtimeId: string,
): Promise<'removed' | 'already-gone' | 'failed'> {
  const name = containerName(runtimeId)
  let container: 'removed' | 'already-gone' | 'failed'
  try {
    await runEngine('docker', ['container', 'inspect', '--format', '{{.Id}}', name])
    container = 'removed'
  } catch {
    container = 'already-gone'
  }
  if (container === 'removed') {
    try {
      await runEngine('docker', ['rm', '--force', name])
    } catch {
      container = 'failed'
    }
  }
  // The workspace volume goes with the container; a volume that is not there
  // is fine, one that cannot be removed is not.
  try {
    await runEngine('docker', ['volume', 'rm', '--force', workspaceVolumeName(runtimeId)])
  } catch {
    return 'failed'
  }
  return container
}

/**
 * Apple container reports a missing container or volume as an error on both
 * delete and inspect, so existence is asked first. Only "not found" means
 * gone: an inspect that failed for another reason says nothing about the
 * container, so the forced delete still runs and decides the outcome.
 */
async function teardownAppleRuntime(
  runtimeId: string,
): Promise<'removed' | 'already-gone' | 'failed'> {
  const name = containerName(runtimeId)
  let container: 'removed' | 'already-gone' | 'failed' = 'removed'
  try {
    await runEngine('apple', ['inspect', name])
  } catch (error) {
    if (isNotFound('apple', error)) container = 'already-gone'
  }
  if (container === 'removed') {
    try {
      await runEngine('apple', ['delete', '--force', name])
    } catch {
      container = 'failed'
    }
  }
  const volume = workspaceVolumeName(runtimeId)
  try {
    await runEngine('apple', ['volume', 'inspect', volume])
  } catch (error) {
    if (isNotFound('apple', error)) return container
  }
  try {
    await runEngine('apple', ['volume', 'delete', volume])
  } catch {
    return 'failed'
  }
  return container
}

export interface ManagedRuntime {
  runtimeId: string
  /** The engine's own words for the state (`Up 3 minutes`, `running`, …). */
  status: string
  running: boolean
}

const appleLabelsSchema = z.record(z.string(), z.string()).nullish()
const appleContainerListSchema = z.array(
  z.object({
    configuration: z.object({ labels: appleLabelsSchema }),
    status: z.object({ state: z.string() }),
  }),
)
const appleVolumeListSchema = z.array(
  z.object({ configuration: z.object({ labels: appleLabelsSchema }) }),
)

/** The managed runtimes in `container list --all --format json` output. */
export function parseAppleManagedRuntimes(listJson: string): ManagedRuntime[] {
  const containers = safeJsonParse(listJson, decodeWithSchema(appleContainerListSchema))
  if (containers === null) throw new Error('container list returned something other than a list')
  return containers
    .filter((entry) => entry.configuration.labels?.[MANAGED_LABEL] === '1')
    .map((entry) => ({
      runtimeId: entry.configuration.labels?.[RUNTIME_LABEL] ?? '',
      status: entry.status.state,
      running: entry.status.state === 'running',
    }))
}

/** The runtime ids on the managed volumes in `container volume list --format json` output. */
export function parseAppleManagedVolumes(listJson: string): string[] {
  const volumes = safeJsonParse(listJson, decodeWithSchema(appleVolumeListSchema))
  if (volumes === null)
    throw new Error('container volume list returned something other than a list')
  return volumes
    .filter((entry) => entry.configuration.labels?.[MANAGED_LABEL] === '1')
    .map((entry) => entry.configuration.labels?.[RUNTIME_LABEL] ?? '')
    .filter((id) => id.length > 0)
}

/** Every container this host started on `engine` and has not torn down — the orphan sweep. */
export async function listManagedRuntimes(
  engine: ThreadContainerEngine = 'docker',
): Promise<ManagedRuntime[]> {
  if (engine === 'apple') {
    return parseAppleManagedRuntimes(
      await runEngine('apple', ['list', '--all', '--format', 'json']),
    )
  }
  const out = await runEngine('docker', [
    'ps',
    '--all',
    '--filter',
    `label=${MANAGED_LABEL}=1`,
    '--format',
    `{{.Label "${RUNTIME_LABEL}"}}\t{{.Status}}`,
  ])
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [runtimeId = '', status = ''] = line.split('\t')
      return { runtimeId, status, running: status.startsWith('Up') }
    })
}

/** Every workspace volume this host created on `engine`, by the runtime id on its label. */
export async function listManagedVolumes(
  engine: ThreadContainerEngine = 'docker',
): Promise<string[]> {
  if (engine === 'apple') {
    return parseAppleManagedVolumes(
      await runEngine('apple', ['volume', 'list', '--format', 'json']),
    )
  }
  const out = await runEngine('docker', [
    'volume',
    'ls',
    '--filter',
    `label=${MANAGED_LABEL}=1`,
    '--format',
    `{{.Label "${RUNTIME_LABEL}"}}`,
  ])
  return out.split('\n').filter((line) => line.trim().length > 0)
}

export interface OrphanSweep {
  /** Runtimes whose container and volume are gone now. */
  removed: string[]
  /** Runtimes still running — another app instance's, or one this host lost and that is winding itself down. */
  skipped: string[]
  /** Runtimes Docker would not let go of. */
  failed: string[]
}

/**
 * Tear down every managed runtime that is not running: the containers and
 * workspace volumes a run left behind when the app quit before its teardown.
 * A running container is left alone — it may belong to another instance of
 * the app sharing this daemon, and one this host abandoned stops on its own
 * once its link closed (decision A8) — and is swept on a later start.
 * Every engine that is up is swept: a run is on whichever engine it was
 * resolved to, and the previous session may have used the other one.
 */
export async function sweepOrphanedRuntimes(
  engines?: readonly ThreadContainerEngine[],
): Promise<OrphanSweep> {
  const sweep: OrphanSweep = { removed: [], skipped: [], failed: [] }
  for (const engine of engines ?? (await reachableThreadContainerEngines())) {
    const containers = await listManagedRuntimes(engine)
    const volumes = await listManagedVolumes(engine)
    const running = new Set(containers.filter((c) => c.running).map((c) => c.runtimeId))
    const candidates = new Set(
      [...containers.map((c) => c.runtimeId), ...volumes].filter(
        (id) => id.length > 0 && !running.has(id),
      ),
    )
    sweep.skipped.push(...running)
    for (const runtimeId of candidates) {
      const outcome = await teardownRuntime(runtimeId, engine)
      if (outcome === 'failed') sweep.failed.push(runtimeId)
      else sweep.removed.push(runtimeId)
    }
  }
  return sweep
}

/**
 * How long `docker stop` may take at the deadline, and how long after that we
 * still give `docker wait` to notice the container left. Both are bounded
 * because the whole point of the deadline is that the run cannot outlive it: a
 * Docker daemon that hangs must not strand the caller before its cleanup block.
 */
const START_TIMEOUT_MS = 30_000
const START_POLL_MS = 100
const DETACH_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 45_000
const SETTLE_AFTER_STOP_MS = 15_000

export interface ContainerWaitOutcome {
  exit: number | null
  timedOut: boolean
  /** Non-null when the deadline stop failed, or the wait never settled after it. */
  cleanupError: string | null
}

/** The two Docker calls the wait makes, injectable so their failures are testable. */
/**
 * Start a created container attached: its stdout and stdin become the egress
 * link when the run has one, its stderr the run's log, line by line as it
 * happens. Without egress the guest's stdin is closed at once and its stdout
 * is only ever empty.
 */
function attachContainer(
  engine: ThreadContainerEngine,
  name: string,
  options: {
    broker: EgressBroker | null
    onLog: (line: string) => void
    onPhase?: ((phase: WorkerPhase) => void) | undefined
  },
): ChildProcess {
  const child = spawn(engineCommand(engine), ['start', '--attach', '--interactive', name], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (options.broker) options.broker.attach(child.stdout, child.stdin)
  else child.stdin.end()
  child.stdin.on('error', () => {
    // EPIPE once the container is gone; the link's own close handles it.
  })
  createInterface({ input: child.stderr }).on('line', (line) => {
    const phase = decodeWorkerPhase(line)
    if (phase !== null) {
      options.onPhase?.(phase)
      return
    }
    options.onLog(line)
  })
  child.on('error', (error) => {
    options.onLog(`[thread-container] ${engineCommand(engine)} start failed: ${error.message}`)
  })
  return child
}

/**
 * `docker wait` on a container that is still `created` returns at once, so the
 * wait must not begin until the daemon has started it. Polls until the state
 * has moved on, or the attached start has died without moving it.
 */
async function untilStarted(
  engine: ThreadContainerEngine,
  name: string,
  attached: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    let started = false
    try {
      started =
        engine === 'apple'
          ? appleContainerStarted(await runEngine('apple', ['inspect', name]))
          : !['', 'created'].includes(
              await runEngine('docker', [
                'container',
                'inspect',
                '--format',
                '{{.State.Status}}',
                name,
              ]),
            )
    } catch {
      // Not inspectable yet; the loop's deadline bounds this.
    }
    if (started) return
    if (attached.exitCode !== null) {
      throw new Error(
        `the container did not start (${engineCommand(engine)} start exited ${String(attached.exitCode)})`,
      )
    }
    if (Date.now() > deadline) throw new Error('the container did not start in time')
    await new Promise((resolveTick) => setTimeout(resolveTick, START_POLL_MS))
  }
}

/** The attached start exits with the container; give it a moment, then let it go. */
function detachContainer(child: ChildProcess): Promise<void> {
  return new Promise((resolveDetach) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveDetach()
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolveDetach()
    }, DETACH_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveDetach()
    })
    child.stdin?.end()
  })
}

export interface WaitForContainerDependencies {
  /** `docker wait`: resolves with its stdout when it closes; `cancel` gives up on it. */
  wait: (name: string) => { output: Promise<string>; cancel: () => void }
  /** `docker stop`: rejects when the daemon refuses or takes too long. */
  stop: (name: string) => Promise<void>
  settleAfterStopMs?: number
}

const dockerWaitDependencies: WaitForContainerDependencies = {
  wait: (name) => {
    const child = spawn('docker', ['wait', name], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    return {
      output: new Promise<string>((resolveOutput, rejectOutput) => {
        child.on('error', rejectOutput)
        child.on('close', () => {
          resolveOutput(out)
        })
      }),
      cancel: (): void => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      },
    }
  },
  stop: async (name) => {
    await execFileAsync('docker', ['stop', '--time', '30', name], { timeout: STOP_TIMEOUT_MS })
  },
}

/**
 * Apple container has no `wait`, and its inspect records no exit status. The
 * attached `container start` is the wait: it exits when the guest does, with
 * the guest's own code (measured: 7 for `exit 7`, 143 after a stop's SIGTERM,
 * 137 once the stop's grace ran out).
 */
function appleWaitDependencies(attached: ChildProcess): WaitForContainerDependencies {
  return {
    wait: () => ({
      output: new Promise<string>((resolveOutput) => {
        const report = (): void => {
          resolveOutput(attached.exitCode === null ? '' : String(attached.exitCode))
        }
        if (attached.exitCode !== null || attached.signalCode !== null) report()
        else attached.once('exit', report)
      }),
      // The attached start is detached in the runner's cleanup, not here.
      cancel: (): void => {},
    }),
    stop: async (name): Promise<void> => {
      await execFileAsync('container', ['stop', '--time', '30', name], {
        timeout: STOP_TIMEOUT_MS,
      })
    },
  }
}

/**
 * Wait for the container, bounded by the run's wall-clock budget.
 *
 * `docker wait` closing is the happy path. At the deadline the daemon is asked
 * to stop the container, but neither that request nor the wait is trusted to
 * settle: the stop has its own timeout, and a further grace period settles this
 * promise regardless, so the caller always reaches its cleanup block. A stop
 * that failed, or a wait that never closed, is reported as `cleanupError` and
 * never swallowed — the container may still be running, and the `docker rm
 * --force` in teardown is the next line of defence.
 */
export function waitForContainer(
  name: string,
  wallClockMs: number,
  dependencies: WaitForContainerDependencies = dockerWaitDependencies,
): Promise<ContainerWaitOutcome> {
  const settleAfterStopMs = dependencies.settleAfterStopMs ?? SETTLE_AFTER_STOP_MS
  return new Promise((resolveWait) => {
    const waiting = dependencies.wait(name)
    let out = ''
    let timedOut = false
    let settled = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined

    const settle = (cleanupError: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (settleTimer) clearTimeout(settleTimer)
      // Nothing more to learn from the wait; do not leave it running.
      waiting.cancel()
      const code = Number.parseInt(out.trim(), 10)
      resolveWait({ exit: Number.isFinite(code) ? code : null, timedOut, cleanupError })
    }

    const deadline = setTimeout(() => {
      timedOut = true
      void dependencies
        .stop(name)
        .then(() => null)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
        .then((stopError) => {
          if (settled) return
          // Give the wait a bounded chance to observe the stop, then settle
          // whatever happened — a hung wait must not outlive the deadline.
          settleTimer = setTimeout(() => {
            settle(
              stopError ?? 'the container did not exit after the wall-clock stop; forcing teardown',
            )
          }, settleAfterStopMs)
        })
    }, wallClockMs)

    waiting.output.then(
      (output) => {
        out = output
        settle(null)
      },
      (error: unknown) => {
        settle(`docker wait failed: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  })
}

/**
 * `container inspect` for one container: the configuration it was created
 * with, as Apple container recorded it, and its state. Only the fields the
 * run's hardening depends on are decoded; an engine that stops reporting one
 * fails the decode, and so the run, rather than passing unverified.
 */
const appleContainerInspectSchema = z
  .array(
    z.object({
      configuration: z.object({
        capAdd: z.array(z.string()),
        capDrop: z.array(z.string()),
        readOnly: z.boolean(),
        networks: z.array(z.unknown()),
        useInit: z.boolean(),
        ssh: z.boolean(),
        virtualization: z.boolean(),
        publishedPorts: z.array(z.unknown()),
        publishedSockets: z.array(z.unknown()),
        labels: z.record(z.string(), z.string()),
        resources: z.object({ cpus: z.number(), memoryInBytes: z.number() }),
        initProcess: z.object({
          user: z.object({ raw: z.object({ userString: z.string() }) }),
          rlimits: z.array(z.object({ limit: z.string(), soft: z.number(), hard: z.number() })),
        }),
        mounts: z.array(
          z.object({
            destination: z.string(),
            options: z.array(z.string()),
            type: z.record(z.string(), z.unknown()),
          }),
        ),
      }),
      status: z.object({ state: z.string(), startedDate: z.string().optional() }),
    }),
  )
  .length(1)

type AppleContainerInspect = z.infer<typeof appleContainerInspectSchema>[number]

function decodeAppleInspect(inspectJson: string): AppleContainerInspect | null {
  return safeJsonParse(inspectJson, decodeWithSchema(appleContainerInspectSchema))?.[0] ?? null
}

/**
 * A created Apple container reads `stopped` until it starts (there is no
 * `created` state); one that has started carries a start date whatever its
 * state now.
 */
export function appleContainerStarted(inspectJson: string): boolean {
  const container = decodeAppleInspect(inspectJson)
  if (container === null) return false
  return container.status.state === 'running' || container.status.startedDate !== undefined
}

/** `4g` → bytes, as Apple container records `--memory`. */
function memoryBytes(limit: string): number | null {
  const match = /^(\d+)([kmgt]?)$/i.exec(limit)
  if (!match) return null
  const exponent = ['', 'k', 'm', 'g', 't'].indexOf((match[2] ?? '').toLowerCase())
  return Number(match[1]) * 1024 ** exponent
}

/**
 * Why the container Apple container created is not the one the run asked
 * for, or null when every hardening flag is in its recorded configuration.
 * Apple container accepts options it then does not apply (a volume's
 * `--opt uid=` is one), so the attestation is only written for what the
 * engine reports back — anything missing, and anything extra, refuses the run.
 */
export function appleConfigShortfall(input: ContainerRunInput, inspectJson: string): string | null {
  const container = decodeAppleInspect(inspectJson)
  if (container === null) return 'container inspect did not describe the container'
  const config = container.configuration
  const uid = String(WORKER_UID)
  if (!config.capDrop.some((cap) => cap.toUpperCase() === 'ALL')) {
    return 'capabilities were not dropped'
  }
  if (config.capAdd.length > 0) return `capabilities were added: ${config.capAdd.join(', ')}`
  if (!config.readOnly) return 'the root filesystem is writable'
  if (config.networks.length > 0) return 'the container is attached to a network'
  if (config.initProcess.user.raw.userString !== `${uid}:${uid}`) {
    return `the worker runs as ${config.initProcess.user.raw.userString}`
  }
  const nproc = config.initProcess.rlimits.find((limit) => limit.limit === 'RLIMIT_NPROC')
  if (nproc?.soft !== input.pidsLimit || nproc.hard !== input.pidsLimit) {
    return 'the process limit was not applied'
  }
  if (config.resources.cpus !== input.cpus) return 'the CPU limit was not applied'
  if (config.resources.memoryInBytes !== memoryBytes(input.memoryLimit)) {
    return 'the memory limit was not applied'
  }
  if (config.ssh) return 'the host SSH agent is forwarded'
  if (config.virtualization) return 'nested virtualization is exposed'
  if (config.publishedPorts.length > 0 || config.publishedSockets.length > 0) {
    return 'a port or socket is published to the host'
  }
  if (!config.useInit) return 'the init process is missing'
  if (config.labels[MANAGED_LABEL] !== '1' || config.labels[RUNTIME_LABEL] !== input.runtimeId) {
    return 'the container is not labelled as this run'
  }
  const expected: Record<
    string,
    (mount: AppleContainerInspect['configuration']['mounts'][number]) => boolean
  > = {
    '/tmp': (mount): boolean => Object.hasOwn(mount.type, 'tmpfs'),
    '/workspace': (mount): boolean => {
      const volume = mount.type['volume']
      return isRecord(volume) && volume['name'] === workspaceVolumeName(input.runtimeId)
    },
    [GUEST_RUN_DIR]: (mount): boolean => mount.options.includes('ro'),
    [`${GUEST_RUN_DIR}/state`]: (mount): boolean => !mount.options.includes('ro'),
    [`${GUEST_RUN_DIR}/out`]: (mount): boolean => !mount.options.includes('ro'),
  }
  const seen = new Set<string>()
  for (const mount of config.mounts) {
    const check = Object.hasOwn(expected, mount.destination)
      ? expected[mount.destination]
      : undefined
    if (check === undefined) return `unexpected mount at ${mount.destination}`
    if (!check(mount)) return `the mount at ${mount.destination} is not the one asked for`
    seen.add(mount.destination)
  }
  const missing = Object.keys(expected).find((destination) => !seen.has(destination))
  if (missing !== undefined) return `the mount at ${missing} is missing`
  return null
}

function readJsonFile<T>(path: string, decode: (value: unknown) => T | null): T | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return decode(parsed)
  } catch {
    return null
  }
}

/**
 * The secret canary (`unattended-runs.md` U3): a marker value present in the
 * host environment must be absent from everything the guest could see or wrote.
 * The guest's own environment is checked from inside by the worker (it reports
 * it in the result); the host checks the surfaces it owns.
 */
export function secretCanaryCheck(
  runDir: string,
  canary: string,
): { present: boolean; detail: string } {
  const surfaces = [
    'run.json',
    'attestation.json',
    join('out', 'result.json'),
    join('out', 'messages.json'),
  ]
  for (const surface of surfaces) {
    const path = join(runDir, surface)
    if (!existsSync(path)) continue
    if (readFileSync(path, 'utf8').includes(canary)) {
      return { present: true, detail: `canary found in ${surface}` }
    }
  }
  return { present: false, detail: `canary absent from ${surfaces.join(', ')}` }
}

export interface RunThreadOptions {
  /** Injected for tests; defaults to a fresh value. */
  runtimeId?: string
  onLog?: (line: string) => void
  onPhase?: (phase: WorkerPhase) => void
  /** Called once the container is running, i.e. the guest holds its environment. */
  onStarted?: () => void
  /**
   * A stop asked for before the container exists (the snapshot and bundle of
   * a large checkout take a while): the runner refuses to create it and, if
   * the ask lands while `docker run` is in flight, tears it down at once.
   * A stop after that is a force-remove, which settles the wait on its own.
   */
  signal?: AbortSignal
  /** Host-side canary value; defaults to a random marker exported to the child env. */
  canary?: string
}

const STOPPED_BEFORE_START = 'Stopped by you before the container started'

/** Provision → carry in → run → carry out → record → tear down. */
export async function runThreadInContainer(
  request: ThreadContainerRequest,
  options: RunThreadOptions = {},
): Promise<ThreadContainerRecord> {
  const log =
    options.onLog ??
    ((line: string): void => {
      console.log(line)
    })
  const runtimeId = options.runtimeId ?? newRuntimeId()
  const image = request.image ?? WORKER_IMAGE
  const workspace = resolve(request.workspace)
  const runtimesDir = resolve(request.runtimesDir ?? join(copseDataRoot(), 'runtimes'))
  const runDir = join(runtimesDir, runtimeId)
  const egress = request.egressAllowlist.map(parseEgressRule)
  if (request.provider === undefined && request.acp === undefined) {
    throw new Error('A run needs a provider description or an ACP agent')
  }
  if (request.provider !== undefined) {
    const provider = providerOrigin(providerEndpointUrl(request.provider))
    if (findEgressRule(egress, provider.host, provider.port) === null) {
      throw new Error(
        `Provider origin ${provider.host}:${String(provider.port)} is not in the egress allowlist; the guest could never reach it`,
      )
    }
  }
  const apiKeyEnv = request.apiKeyEnv ?? null
  if (apiKeyEnv && !process.env[apiKeyEnv]) {
    throw new Error(`Provider key variable ${apiKeyEnv} is not set on the host`)
  }
  const canary = options.canary ?? `copse-canary-${randomBytes(8).toString('hex')}`
  process.env['COPSE_SECRET_CANARY'] = canary
  const engine = request.engine ?? (await assertThreadContainerEngine())
  log(`[thread-container] engine: ${engine === 'apple' ? 'Apple container' : 'Docker'}`)

  for (const sub of ['', 'state', 'out']) {
    mkdirSync(join(runDir, sub), { recursive: true })
  }
  // The guest runs as an unprivileged uid the host does not share; these
  // directories are its only writable host paths, and they are private to the run.
  chmodSync(join(runDir, 'state'), 0o777)
  chmodSync(join(runDir, 'out'), 0o777)

  const carryIn = await writeCarryInBundle(
    workspace,
    runtimeId,
    join(runDir, 'carry-in.bundle'),
    request.carryInRef,
  )
  log(`[thread-container] carry-in ${carryIn.sha.slice(0, 12)} as ${carryIn.ref}`)

  // The user's sign-in, when they opted in: staged now, removed in `finally`
  // below whatever happens, so the world-readable copy lives only as long as
  // the container it exists for.
  let acp = request.acp
  let stagedLogin: string[] | null = null
  if (acp?.login) {
    stagedLogin = await stageAgentLogin(homedir(), acp.login.files, runDir, acp.agent.title)
    acp = { ...acp, login: { files: stagedLogin } }
    log(`[thread-container] sign-in carried in: ${stagedLogin.map((d) => `~/${d}`).join(', ')}`)
  }

  // The guest's thread is its own; the record names the desktop thread.
  const guestThreadId = `${runtimeId}-thread`
  const spec: ThreadContainerRunSpec = {
    runtimeId,
    threadId: guestThreadId,
    projectId: `${runtimeId}-project`,
    prompt: request.prompt,
    model: request.model,
    provider: request.provider ?? null,
    contextWindow: request.contextWindow ?? null,
    apiKeyEnv,
    acp: acp ?? null,
    installDependencies: request.installDependencies === true,
    budgets: request.budgets,
    workspace: GUEST_WORKSPACE,
    carryInRef: carryIn.ref,
    carryInBase: carryIn.sha,
    originUrl: sanitizedOriginUrl(await originUrlOf(workspace)),
    maxSteps: request.maxSteps ?? null,
  }
  const installs = request.installDependencies === true
  if (installs && engine === 'apple') {
    log(
      '[thread-container] no shared pnpm store under Apple container (a volume attaches to one container at a time); the install fetches every package',
    )
  }
  const runInput: ContainerRunInput = {
    engine,
    runtimeId,
    image,
    runDir,
    egress,
    egressToken: egress.length > 0 ? randomBytes(16).toString('hex') : null,
    sharedStore: installs && engine === 'docker',
    apiKeyEnv,
    memoryLimit: '4g',
    pidsLimit: 512,
    cpus: 2,
  }
  const digest = await imageDigest(image, engine)
  const attestation = buildAttestation(runInput, digest)
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(spec, null, 2)}\n`)
  writeFileSync(join(runDir, 'attestation.json'), `${JSON.stringify(attestation, null, 2)}\n`)

  const broker = new EgressBroker({
    rules: egress,
    ...(request.egressResolve ? { resolve: request.egressResolve } : {}),
  })
  const startedAt = Date.now()
  let containerExit: number | null
  let teardown: ThreadContainerRecord['teardown']
  let cleanupError: string | null = null
  let attached: ChildProcess | null = null
  try {
    if (options.signal?.aborted) throw new Error(STOPPED_BEFORE_START)
    options.onPhase?.('running')
    log(`[thread-container] starting ${containerName(runtimeId)} from ${image}`)
    await runEngine(engine, [
      'volume',
      'create',
      '--label',
      `${MANAGED_LABEL}=1`,
      '--label',
      `${RUNTIME_LABEL}=${runtimeId}`,
      workspaceVolumeName(runtimeId),
    ])
    if (engine === 'apple') await runEngine('apple', appleVolumePrepareArgs(runInput))
    if (runInput.sharedStore) await ensurePnpmStoreVolume()
    await runEngine(engine, containerCreateArgs(runInput))
    if (engine === 'apple') {
      // The attestation is already written; refuse to start a guest it
      // would misdescribe. The `finally` below removes the container.
      const shortfall = appleConfigShortfall(
        runInput,
        await runEngine('apple', ['inspect', containerName(runtimeId)]),
      )
      if (shortfall !== null) {
        throw new Error(
          `Apple container did not apply the hardening this run requires (${shortfall}); refusing to start it`,
        )
      }
    }
    // The container exists now; a stop that landed while it was being made
    // has nothing to remove yet, so the `finally` below is the removal.
    if (options.signal?.aborted) throw new Error(STOPPED_BEFORE_START)
    attached = attachContainer(engine, containerName(runtimeId), {
      broker: egress.length > 0 ? broker : null,
      onPhase: options.onPhase,
      onLog: (line) => {
        log(`[guest] ${line}`)
      },
    })
    await untilStarted(engine, containerName(runtimeId), attached)
    options.onStarted?.()
    const waited = await waitForContainer(
      containerName(runtimeId),
      request.budgets.wallClockMs,
      engine === 'apple' ? appleWaitDependencies(attached) : dockerWaitDependencies,
    )
    containerExit = waited.exit
    cleanupError = waited.cleanupError
    if (waited.timedOut) log('[thread-container] wall-clock budget reached; container stopped')
    if (cleanupError !== null) log(`[thread-container] cleanup problem: ${cleanupError}`)
  } finally {
    options.onPhase?.('collecting')
    teardown = await teardownRuntime(runtimeId, engine)
    if (teardown === 'failed') {
      const failure = `the container ${containerName(runtimeId)} could not be removed`
      cleanupError = cleanupError === null ? failure : `${cleanupError}; ${failure}`
      log(`[thread-container] ${failure}`)
    }
    broker.stop()
    if (attached) await detachContainer(attached)
    removeStagedLogin(runDir)
  }

  const decoded = readJsonFile(
    join(runDir, 'out', 'result.json'),
    decodeWithSchema(threadContainerResultSchema),
  )
  // The agent's last words name files by their guest path; the desktop wants
  // them relative to the checkout (A14).
  const result = decoded ? { ...decoded, finalText: relocateGuestPaths(decoded.finalText) } : null
  const carryOutBundle = join(runDir, 'out', 'carry-out.bundle')
  const carryOut: ThreadContainerRecord['carryOut'] = {
    expected: existsSync(carryOutBundle) || (result?.commits.length ?? 0) > 0,
    ref: null,
    error: null,
  }
  if (carryOut.expected) {
    try {
      carryOut.ref = await fetchCarryOut(workspace, runtimeId, carryOutBundle)
      log(`[thread-container] carry-out fetched to ${carryOut.ref}`)
    } catch (error) {
      // The bundle stays in the run directory, so the work is recoverable —
      // but the ref the record advertises does not exist, and saying the
      // commits are back would be a lie.
      carryOut.error = error instanceof Error ? error.message : String(error)
      log(`[thread-container] carry-out fetch FAILED: ${carryOut.error}`)
    }
  }
  const record: ThreadContainerRecord = {
    runtimeId,
    threadId: request.threadId ?? guestThreadId,
    startedAt,
    finishedAt: Date.now(),
    image,
    imageDigest: digest ?? null,
    attestation,
    egress: broker.log(),
    result,
    transcript: relocateTranscript(
      readJsonFile(join(runDir, 'out', 'transcript.json'), decodeGuestTranscript) ?? [],
    ),
    carryIn: { sha: carryIn.sha, dirty: carryIn.dirty },
    carryOut,
    containerExit,
    credential: stagedLogin ? { login: stagedLogin } : apiKeyEnv ? 'key' : 'none',
    teardown,
    cleanupError,
    secretCanary: secretCanaryCheck(runDir, canary),
  }
  writeFileSync(join(runDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}
