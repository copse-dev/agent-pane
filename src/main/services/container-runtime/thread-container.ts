/**
 * Run one Copse thread inside a disposable, hardened local Docker container
 * (`docs/plans/thread-in-container.md`).
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
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { z } from 'zod'
import type {
  ContainerRuntimeAttestation,
  UnattendedRunBudgets,
} from '@shared/types/unattended-run.ts'
import type { ThreadContainerRecord, ThreadContainerResult } from '@shared/types/container-run.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { EgressBroker } from './egress-broker.ts'
import {
  GUEST_EGRESS_PROXY,
  BROKER_SOCKET_NAME,
  findEgressRule,
  formatEgressRule,
  parseEgressRule,
  type EgressRule,
} from './egress-rules.ts'
import { WORKER_DOCKERFILE, WORKER_ENTRYPOINT_SH } from './worker-image-files.ts'
import { containerAcpAgentSpecs } from '@shared/container-acp-agents.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'

const execFileAsync = promisify(execFile)

export const WORKER_IMAGE = 'copse-worker:local'
export const WORKER_UID = 1001
export const GUEST_RUN_DIR = '/run/copse'
export const GUEST_WORKSPACE = '/workspace/repo'
export const CARRY_IN_REF_PREFIX = 'refs/copse/carry-in/'
export const CARRY_OUT_REF_PREFIX = 'refs/copse/runs/'
export const MANAGED_LABEL = 'dev.copse.managed'
/** Identifies which worker build an image was made from; see {@link workerImageFingerprint}. */
export const FINGERPRINT_LABEL = 'dev.copse.worker-fingerprint'
export const RUNTIME_LABEL = 'dev.copse.runtime'
export const SANDBOX_RUNTIME_PACKAGE = '@anthropic-ai/sandbox-runtime'

/** What the CLI or a test asks for. */
export type { ThreadContainerRecord, ThreadContainerResult } from '@shared/types/container-run.ts'

export interface ThreadContainerRequest {
  /** Local git checkout to carry in. */
  workspace: string
  prompt: string
  /** Product model id as the settings UI would store it, e.g. `local:qwen`. */
  model: string
  /**
   * OpenAI-compatible base URL the guest should talk to, e.g.
   * `http://model.copse.internal:8080/v1`. Its host:port must be in the
   * egress allowlist; that is the only route out of the guest. Omit for a
   * provider the product resolves itself in the guest (`productProvider`).
   */
  providerUrl?: string
  /**
   * Let the guest build the provider through the product's own resolver from
   * the model id and this one API key (Anthropic today). The key's origin must
   * still be in the egress allowlist.
   */
  productProvider?: { apiKeySlug: string }
  /** Environment variable on the host holding the provider key; the value is passed, never the name. */
  apiKeyEnv?: string
  /**
   * Run the thread under an external ACP agent instead of Copse's own loop
   * (`docs/plans/thread-in-container.md`, "Agent models in the guest"). The
   * agent binary must be in the image; the run's one key reaches it through
   * `keyEnvName` in its environment. Its origins must be in the allowlist.
   */
  acp?: ThreadContainerAcpHarness
  budgets: UnattendedRunBudgets
  /** `host:port` and `*.suffix:port` rules the broker admits. Nothing else is reachable. */
  egressAllowlist: string[]
  /**
   * Guest-facing origin name → `addr` or `addr:port` the host dials instead, for
   * names only the guest knows (a scripted origin on loopback playing a real one).
   */
  egressResolve?: Record<string, string>
  image?: string
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
}

/** The spec the guest reads from `run.json`. Contains no secrets. */
export interface ThreadContainerRunSpec {
  runtimeId: string
  threadId: string
  projectId: string
  prompt: string
  model: string
  providerUrl: string | null
  productProvider: { apiKeySlug: string } | null
  apiKeyEnv: string | null
  acp: ThreadContainerAcpHarness | null
  budgets: UnattendedRunBudgets
  workspace: string
  carryInRef: string
  carryInBase: string
  maxSteps: number | null
}

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

/**
 * Where a run's broker sockets live on the host: short, private to the run.
 *
 * Short on purpose. A unix socket path is capped by `sun_path` — 104 bytes on
 * macOS, 108 on Linux, both counting the NUL — and macOS hands every process a
 * per-user temp root like `/var/folders/r5/qll_28695_q_.../T/` that is already
 * ~49 bytes. Spelling the whole runtime id here spent 32 more and pushed real
 * runs over the limit, so the directory carries a digest of the id instead. The
 * full id stays in `run.json` beside it, which is where anyone debugging looks.
 */
export function egressSocketDir(runtimeId: string): string {
  const digest = createHash('sha256').update(runtimeId).digest('hex').slice(0, 10)
  return join(tmpdir(), `copse-cx-${digest}`)
}

export interface DockerRunInput {
  runtimeId: string
  image: string
  runDir: string
  /** Short host path holding the broker sockets; see {@link egressSocketDir}. */
  egressDir: string
  egress: EgressRule[]
  apiKeyEnv: string | null
  memoryLimit: string
  pidsLimit: number
  cpus: number
}

/**
 * The `docker run` argv for one run. Every hardening flag the attestation
 * later claims is set here and nowhere else, so the two cannot drift.
 */
export function dockerRunArgs(input: DockerRunInput): string[] {
  const args = [
    'run',
    '--detach',
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
    // bubblewrap inside the guest needs user namespaces, which Docker's default
    // seccomp profile refuses. The trade is the one the autonomy eval already
    // makes: the guest keeps namespaces, cap-drop and no-new-privileges; the
    // syscall filter is what bubblewrap then applies per command.
    '--security-opt=seccomp=unconfined',
    '--security-opt=apparmor=unconfined',
    '--security-opt=systempaths=unconfined',
    `--pids-limit=${String(input.pidsLimit)}`,
    `--memory=${input.memoryLimit}`,
    `--cpus=${String(input.cpus)}`,
    `--user=${String(WORKER_UID)}:${String(WORKER_UID)}`,
    // tmpfs mounts are root-owned by default regardless of the image; the
    // worker uid must own its scratch, workspace and home.
    '--tmpfs=/tmp:rw,nosuid,nodev,size=1g,mode=1777',
    `--tmpfs=/workspace:rw,nosuid,nodev,size=2g,uid=${String(WORKER_UID)},gid=${String(WORKER_UID)},mode=0755`,
    `--tmpfs=/home/copse:rw,nosuid,nodev,size=256m,uid=${String(WORKER_UID)},gid=${String(WORKER_UID)},mode=0750`,
    '--network=none',
    '--stop-timeout=30',
  ]
  args.push(
    '--volume',
    `${input.runDir}:${GUEST_RUN_DIR}:ro`,
    '--volume',
    `${join(input.runDir, 'state')}:${GUEST_RUN_DIR}/state:rw`,
    '--volume',
    `${join(input.runDir, 'out')}:${GUEST_RUN_DIR}/out:rw`,
    '--volume',
    `${input.egressDir}:${GUEST_RUN_DIR}/egress:rw`,
    '--env',
    `COPSE_DIR=${GUEST_RUN_DIR}/state`,
    '--env',
    'HOME=/home/copse',
  )
  if (input.egress.length > 0) {
    // One broker socket, and a loopback proxy in the guest that opens it per
    // request. Every client in the guest is pointed at that proxy: Node's own
    // fetch (the worker's SDK calls) through NODE_USE_ENV_PROXY, and any child
    // that honours the conventional variables — git, curl, an agent CLI. Both
    // spellings, because the tools are split on which one they read. NO_PROXY
    // is emptied so nothing decides to go direct; there is nowhere direct to go.
    const proxy = `http://${GUEST_EGRESS_PROXY.host}:${String(GUEST_EGRESS_PROXY.port)}`
    args.push(
      '--env',
      `COPSE_EGRESS_SOCKET=${GUEST_RUN_DIR}/egress/${BROKER_SOCKET_NAME}`,
      '--env',
      `HTTPS_PROXY=${proxy}`,
      '--env',
      `HTTP_PROXY=${proxy}`,
      '--env',
      `https_proxy=${proxy}`,
      '--env',
      `http_proxy=${proxy}`,
      '--env',
      'NO_PROXY=',
      '--env',
      'no_proxy=',
      '--env',
      'NODE_USE_ENV_PROXY=1',
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

export function buildAttestation(
  input: DockerRunInput,
  imageDigest: string | undefined,
): ContainerRuntimeAttestation {
  return {
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
    egressAllowlist: input.egress.map(formatEgressRule),
    hostMounts: [
      GUEST_RUN_DIR,
      `${GUEST_RUN_DIR}/state`,
      `${GUEST_RUN_DIR}/out`,
      `${GUEST_RUN_DIR}/egress`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Workspace carry-in / carry-out (git-first; no host path enters the guest)
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

/**
 * Snapshot the working tree (staged + unstaged + untracked, .gitignore
 * respected) into a commit without touching HEAD or the real index — the same
 * trick `remote-e2e.mts` and the app's worktree backup use. Returns HEAD when
 * the tree is clean.
 */
export function createSnapshotCommit(cwd: string): { sha: string; dirty: boolean } {
  const headSha = git(cwd, ['rev-parse', 'HEAD'])
  const tmp = mkdtempSync(join(tmpdir(), 'copse-carry-in-index-'))
  try {
    const index = { GIT_INDEX_FILE: join(tmp, 'index') }
    git(cwd, ['read-tree', 'HEAD'], index)
    git(cwd, ['add', '-A'], index)
    const tree = git(cwd, ['write-tree'], index)
    if (tree === git(cwd, ['rev-parse', 'HEAD^{tree}'])) return { dirty: false, sha: headSha }
    const sha = git(cwd, [
      '-c',
      'user.name=copse',
      '-c',
      'user.email=copse@copse.invalid',
      'commit-tree',
      tree,
      '-p',
      'HEAD',
      '-m',
      'copse: working-tree snapshot for a container run',
    ])
    return { dirty: true, sha }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Bundle the snapshot under a run-scoped ref so the guest can fetch it by name. */
export function writeCarryInBundle(
  workspace: string,
  runtimeId: string,
  bundlePath: string,
): { ref: string; sha: string } {
  const snapshot = createSnapshotCommit(workspace)
  const ref = `${CARRY_IN_REF_PREFIX}${runtimeId}`
  git(workspace, ['update-ref', ref, snapshot.sha])
  try {
    git(workspace, ['bundle', 'create', bundlePath, ref])
  } finally {
    git(workspace, ['update-ref', '-d', ref])
  }
  return { ref, sha: snapshot.sha }
}

/** Fetch the guest's commits back under `refs/copse/runs/<id>`; the host never pushes. */
export function fetchCarryOut(workspace: string, runtimeId: string, bundlePath: string): string {
  const ref = `${CARRY_OUT_REF_PREFIX}${runtimeId}`
  git(workspace, ['fetch', '--no-tags', bundlePath, `refs/heads/work:${ref}`])
  return ref
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
  hash.update(`base:${options.baseImage ?? ''}\n`)
  // The agents baked in, by pinned version: bumping one rebuilds the image.
  hash.update(`acp-agents:${(options.acpAgents ?? containerAcpAgentSpecs()).join(' ')}\n`)
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
export async function workerImageFingerprint(image: string): Promise<string | null> {
  try {
    const label = await runDocker([
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

export interface BuildImageOptions {
  image?: string
  baseImage?: string
  /** Docker build `--network`; some sandboxes need `host` for apt. */
  buildNetwork?: string
  /**
   * `package@version` specs of the ACP agents to bake in. Defaults to the
   * key-capable catalogue agents (`container-acp-agents.ts`); a test that
   * needs no agent passes `[]` and gets a smaller, faster build.
   */
  acpAgents?: readonly string[]
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
 * Assemble the build context and build the worker image. The context carries
 * only the bundled worker, the sandbox runtime, and the entrypoint — never the
 * repository, never the app's node_modules, never a credential.
 */
export async function buildWorkerImage(options: BuildImageOptions = {}): Promise<string> {
  const image = options.image ?? WORKER_IMAGE
  const workerBundle = options.workerBundle ?? defaultWorkerBundlePath()
  if (!existsSync(workerBundle)) {
    throw new Error(
      `Container worker bundle missing at ${workerBundle}; run \`pnpm run build\` (it is a standalone main bundle)`,
    )
  }
  const fingerprint = workerBuildFingerprint({ ...options, workerBundle })
  const contextDir = resolve(options.contextDir ?? join(tmpdir(), 'copse-worker-context'))
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
  const args = ['build', '--tag', image, '--label', `${FINGERPRINT_LABEL}=${fingerprint}`]
  if (options.buildNetwork) args.push('--network', options.buildNetwork)
  if (options.baseImage) args.push('--build-arg', `BASE_IMAGE=${options.baseImage}`)
  args.push(
    '--build-arg',
    `ACP_AGENTS=${(options.acpAgents ?? containerAcpAgentSpecs()).join(' ')}`,
  )
  args.push('--build-arg', `WORKER_UID=${String(WORKER_UID)}`, contextDir)
  await runDocker(args)
  return image
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function runDocker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await runDocker(['info', '--format', '{{.ServerVersion}}'])
    return true
  } catch {
    return false
  }
}

/** Whether the worker image is present locally (no pull is ever attempted). */
export async function workerImageExists(image: string): Promise<boolean> {
  return (await imageDigest(image)) !== undefined
}

async function imageDigest(image: string): Promise<string | undefined> {
  try {
    const out = await runDocker(['image', 'inspect', '--format', '{{.Id}}', image])
    return out || undefined
  } catch {
    return undefined
  }
}

/**
 * Idempotent: removing a container that is already gone is success, reported
 * distinctly so a reconciliation sweep can tell "I removed it" from "it was
 * already gone" (`docker rm --force` itself no longer distinguishes the two).
 */
export async function teardownRuntime(
  runtimeId: string,
): Promise<'removed' | 'already-gone' | 'failed'> {
  const name = containerName(runtimeId)
  try {
    await runDocker(['container', 'inspect', '--format', '{{.Id}}', name])
  } catch {
    return 'already-gone'
  }
  try {
    await runDocker(['rm', '--force', name])
    return 'removed'
  } catch {
    return 'failed'
  }
}

/** Every container this host started and has not torn down — the orphan sweep. */
export async function listManagedRuntimes(): Promise<Array<{ runtimeId: string; status: string }>> {
  const out = await runDocker([
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
      return { runtimeId, status }
    })
}

/**
 * How long `docker stop` may take at the deadline, and how long after that we
 * still give `docker wait` to notice the container left. Both are bounded
 * because the whole point of the deadline is that the run cannot outlive it: a
 * Docker daemon that hangs must not strand the caller before its cleanup block.
 */
const STOP_TIMEOUT_MS = 45_000
const SETTLE_AFTER_STOP_MS = 15_000

export interface ContainerWaitOutcome {
  exit: number | null
  timedOut: boolean
  /** Non-null when the deadline stop failed, or the wait never settled after it. */
  cleanupError: string | null
}

/** The two Docker calls the wait makes, injectable so their failures are testable. */
export interface WaitForContainerDependencies {
  /** `docker wait`: resolves with its stdout when it closes; `cancel` gives up on it. */
  wait: (name: string) => { output: Promise<string>; cancel: () => void }
  /** `docker stop`: rejects when the daemon refuses or takes too long. */
  stop: (name: string) => Promise<void>
  settleAfterStopMs?: number
}

const productionWaitDependencies: WaitForContainerDependencies = {
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
  dependencies: WaitForContainerDependencies = productionWaitDependencies,
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

function readJsonFile<T>(path: string, decode: (value: unknown) => T | null): T | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return decode(parsed)
  } catch {
    return null
  }
}

const resultSchema = z.object({
  threadId: z.string(),
  stopReason: z.enum(['completed', 'budget:wall-clock', 'budget:tokens', 'aborted', 'error']),
  error: z.string().optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  harness: z.union([z.literal('copse'), z.object({ acp: z.string() })]),
  promptsAttempted: z.number(),
  deferrals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      subject: z.string(),
      reasons: z.array(z.string()).optional(),
    }),
  ),
  denials: z.array(z.object({ subject: z.string(), reasons: z.array(z.string()) })),
  commits: z.array(z.string()),
  containment: z.object({
    declared: z.boolean(),
    declineReason: z.string().nullable(),
    projectSandbox: z.boolean(),
  }),
  toolNames: z.array(z.string()),
  finalText: z.string(),
})

function decodeResult(value: unknown): ThreadContainerResult | null {
  const parsed = resultSchema.safeParse(value)
  if (!parsed.success) return null
  const { error, deferrals, ...rest } = parsed.data
  return {
    ...rest,
    deferrals: deferrals.map(({ reasons, ...entry }) => ({
      ...entry,
      ...(reasons !== undefined ? { reasons } : {}),
    })),
    ...(error !== undefined ? { error } : {}),
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
  /** Called once `docker run` has returned, i.e. the guest holds its environment. */
  onStarted?: () => void
  /** Host-side canary value; defaults to a random marker exported to the child env. */
  canary?: string
}

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
  if (
    request.providerUrl === undefined &&
    request.productProvider === undefined &&
    request.acp === undefined
  ) {
    throw new Error('A run needs a provider URL, a product-resolved provider, or an ACP agent')
  }
  if (request.providerUrl !== undefined) {
    const provider = providerOrigin(request.providerUrl)
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

  // `egress` in the run dir is only the mountpoint: the read-only bind of the
  // run dir cannot grow one, so it must exist before the container starts.
  for (const sub of ['', 'state', 'out', 'egress']) {
    mkdirSync(join(runDir, sub), { recursive: true })
  }
  // Unix socket paths are capped at ~104 bytes, and a profile directory (macOS
  // `Application Support`, a deep checkout) easily exceeds that, so the broker's
  // sockets live in a short per-run directory under the system temp root and
  // are mounted into the guest from there.
  const egressDir = egressSocketDir(runtimeId)
  mkdirSync(egressDir, { recursive: true })
  // The guest runs as an unprivileged uid the host does not share; these
  // directories are its only writable host paths, and they are private to the run.
  chmodSync(join(runDir, 'state'), 0o777)
  chmodSync(join(runDir, 'out'), 0o777)
  chmodSync(egressDir, 0o777)

  const carryIn = writeCarryInBundle(workspace, runtimeId, join(runDir, 'carry-in.bundle'))
  log(`[thread-container] carry-in ${carryIn.sha.slice(0, 12)} as ${carryIn.ref}`)

  const threadId = `${runtimeId}-thread`
  const spec: ThreadContainerRunSpec = {
    runtimeId,
    threadId,
    projectId: `${runtimeId}-project`,
    prompt: request.prompt,
    model: request.model,
    providerUrl: request.providerUrl ?? null,
    productProvider: request.productProvider ?? null,
    apiKeyEnv,
    acp: request.acp ?? null,
    budgets: request.budgets,
    workspace: GUEST_WORKSPACE,
    carryInRef: carryIn.ref,
    carryInBase: carryIn.sha,
    maxSteps: request.maxSteps ?? null,
  }
  const runInput: DockerRunInput = {
    runtimeId,
    image,
    runDir,
    egressDir,
    egress,
    apiKeyEnv,
    memoryLimit: '4g',
    pidsLimit: 512,
    cpus: 2,
  }
  const digest = await imageDigest(image)
  const attestation = buildAttestation(runInput, digest)
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(spec, null, 2)}\n`)
  writeFileSync(join(runDir, 'attestation.json'), `${JSON.stringify(attestation, null, 2)}\n`)

  const broker = new EgressBroker(egressDir, {
    rules: egress,
    ...(request.egressResolve ? { resolve: request.egressResolve } : {}),
  })
  await broker.start()
  const startedAt = Date.now()
  let containerExit: number | null
  let teardown: ThreadContainerRecord['teardown']
  let cleanupError: string | null = null
  try {
    log(`[thread-container] starting ${containerName(runtimeId)} from ${image}`)
    await runDocker(dockerRunArgs(runInput))
    options.onStarted?.()
    const waited = await waitForContainer(containerName(runtimeId), request.budgets.wallClockMs)
    containerExit = waited.exit
    cleanupError = waited.cleanupError
    if (waited.timedOut) log('[thread-container] wall-clock budget reached; container stopped')
    if (cleanupError !== null) log(`[thread-container] cleanup problem: ${cleanupError}`)
    try {
      const { stdout, stderr } = await execFileAsync(
        'docker',
        ['logs', '--tail', '60', containerName(runtimeId)],
        { maxBuffer: 16 * 1024 * 1024 },
      )
      for (const line of `${stdout}${stderr}`.split('\n')) log(`[guest] ${line}`)
    } catch {
      // logs are a courtesy
    }
  } finally {
    teardown = await teardownRuntime(runtimeId)
    if (teardown === 'failed') {
      const failure = `the container ${containerName(runtimeId)} could not be removed`
      cleanupError = cleanupError === null ? failure : `${cleanupError}; ${failure}`
      log(`[thread-container] ${failure}`)
    }
    await broker.stop()
    rmSync(egressDir, { recursive: true, force: true })
  }

  const result = readJsonFile(join(runDir, 'out', 'result.json'), decodeResult)
  const carryOutBundle = join(runDir, 'out', 'carry-out.bundle')
  const carryOut: ThreadContainerRecord['carryOut'] = {
    expected: existsSync(carryOutBundle) || (result?.commits.length ?? 0) > 0,
    ref: null,
    error: null,
  }
  if (carryOut.expected) {
    try {
      carryOut.ref = fetchCarryOut(workspace, runtimeId, carryOutBundle)
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
    threadId,
    startedAt,
    finishedAt: Date.now(),
    image,
    imageDigest: digest ?? null,
    attestation,
    egress: broker.log(),
    result,
    carryOut,
    containerExit,
    teardown,
    cleanupError,
    secretCanary: secretCanaryCheck(runDir, canary),
  }
  writeFileSync(join(runDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}
