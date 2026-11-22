// The container backend (docs/plans/copse-reviewer.md, §Execution isolation,
// "Backend per shell"; binding decision B3): the strength a foreign diff needs.
//
// Every cell command runs in its own throwaway container from a pinned image,
// with the hardening the thread-in-container runtime settled on
// (`src/main/services/container-runtime/thread-container.ts`, `dockerRunArgs`):
// read-only root, every capability dropped, no new privileges, pid / memory /
// cpu limits, a private exec-able /tmp, and NO network interface at all. The
// two checkouts and the scratch directory are bind-mounted read-write at the
// same absolute paths they have on the host, and the declared read-only paths
// (the dependency store, the corepack cache, the repository's git directory)
// read-only at theirs — so an argv, a cwd, a `npm_config_store_dir` and a
// reproducer's relative path mean the same thing on both sides, and the
// orchestrator's reads of the head checkout see exactly what the cell wrote.
//
// One container per command rather than one per cell: a container is cheap to
// start, `<engine> rm --force` ends a timed-out command and everything it forked in
// one stroke, and nothing in the cell survives between commands except what it
// wrote to its mounted checkouts and scratch — which is the plan's "lifetime"
// row. The engine is Docker by default; Podman speaks the same argv. Apple
// container (Apple silicon, macOS 26+) speaks its own dialect of the same
// verbs, and runs every container in its own lightweight VM; see
// `appleCreateArgs` for how each wall is spelled there.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '@copse/std/errors.ts'
import { memberOf } from '@copse/std/member-of.ts'
import type {
  CellCommand,
  CellCommandResult,
  CellSpec,
  ExecutionCell,
  IsolationBackend,
} from './isolation.ts'
import { collectProcess } from './process-collect.ts'
import { removeTree } from './remove-tree.ts'

export const CONTAINER_BACKEND_ID = 'container'

/** The engine's argv prefix: `['docker']`, `['podman']`, `['container']`, or a test's stand-in. */
export type ContainerEngine = readonly [string, ...string[]]

export const DEFAULT_CONTAINER_ENGINE: ContainerEngine = ['docker']

/** The CLI dialect an engine speaks: Docker's (Docker, Podman) or Apple container's. */
export const CONTAINER_DIALECTS = ['docker', 'apple'] as const
export type ContainerDialect = (typeof CONTAINER_DIALECTS)[number]

/** An engine to try: the argv that drives it and the dialect it speaks. */
export interface ContainerEngineCandidate {
  readonly argv: ContainerEngine
  readonly dialect: ContainerDialect
}

export const DOCKER_ENGINE: ContainerEngineCandidate = { argv: ['docker'], dialect: 'docker' }
export const PODMAN_ENGINE: ContainerEngineCandidate = { argv: ['podman'], dialect: 'docker' }
export const APPLE_CONTAINER_ENGINE: ContainerEngineCandidate = {
  argv: ['container'],
  dialect: 'apple',
}

export interface ContainerLimits {
  /** Docker memory limit syntax (`4g`). */
  readonly memory: string
  readonly pids: number
  readonly cpus: number
}

/** The thread-container runtime's limits, so a review cell is no roomier than a run. */
export const DEFAULT_CONTAINER_LIMITS: ContainerLimits = { memory: '4g', pids: 512, cpus: 2 }

export interface ContainerUser {
  readonly uid: number
  readonly gid: number
}

export type SpawnEngine = (
  file: string,
  args: readonly string[],
  options: { readonly stdio: ['ignore', 'pipe', 'pipe'] | 'ignore' },
) => ChildProcess

export interface ContainerBackendOptions {
  /** The image every command runs from; never pulled by this module. */
  readonly image: string
  readonly engine?: ContainerEngine
  /** The dialect `engine` speaks. Default `docker`. */
  readonly dialect?: ContainerDialect
  readonly limits?: Partial<ContainerLimits>
  /**
   * The name of one command's container. The app maps this onto the
   * thread-container runtime's naming so that runtime's orphan sweep covers
   * review cells a crash left behind; the default is `copse-review-<id>`.
   */
  readonly containerName?: (commandId: string) => string
  /** Labels for one command's container, for the same reason. */
  readonly labels?: (commandId: string) => Readonly<Record<string, string>>
  /**
   * The uid:gid the cell runs as. Default: the orchestrator's own, so the
   * bind-mounted checkouts it created stay writable inside the cell; `null`
   * leaves the image's user. Whatever the uid, the container keeps no
   * capability and cannot gain one.
   */
  readonly user?: ContainerUser | null
  readonly spawn?: SpawnEngine
}

/** Everything `containerCreateArgs` needs; pure in these values. */
export interface ContainerRunInput {
  readonly name: string
  readonly image: string
  readonly labels: Readonly<Record<string, string>>
  readonly user: ContainerUser | null
  readonly limits: ContainerLimits
  /** Bind-mounted read-write at the same path. */
  readonly writable: readonly string[]
  /** Bind-mounted read-only at the same path. */
  readonly readOnly: readonly string[]
  readonly cwd: string
  /** The complete environment the process receives; `PATH` is dropped in favour of the image's. */
  readonly env: Readonly<Record<string, string>>
  readonly argv: readonly [string, ...string[]]
}

/**
 * The `create` argv for one command. Every wall the backend claims through its
 * capabilities is a flag here and nowhere else, pinned by a unit test, so the
 * declaration and the container cannot drift apart.
 */
export function containerCreateArgs(
  input: ContainerRunInput,
  dialect: ContainerDialect = 'docker',
): string[] {
  if (dialect === 'apple') return appleCreateArgs(input)
  const args = ['create', '--rm', '--pull=never', '--name', input.name]
  for (const [key, value] of Object.entries(input.labels)) args.push('--label', `${key}=${value}`)
  args.push(
    '--init',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--pids-limit=${String(input.limits.pids)}`,
    `--memory=${input.limits.memory}`,
    `--cpus=${String(input.limits.cpus)}`,
    // A project's tests write helper scripts to /tmp and run them; the cell's
    // own TMPDIR lives in scratch, this is for anything that ignores it.
    '--tmpfs=/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777',
    '--network=none',
  )
  if (input.user !== null) args.push(`--user=${String(input.user.uid)}:${String(input.user.gid)}`)
  for (const path of new Set(input.writable)) {
    args.push(`--mount=type=bind,source=${path},target=${path}`)
  }
  for (const path of new Set(input.readOnly)) {
    args.push(`--mount=type=bind,source=${path},target=${path},readonly`)
  }
  args.push('--workdir', input.cwd)
  pushEnvironment(args, input.env)
  const [executable, ...argv] = input.argv
  args.push('--entrypoint', executable, input.image, ...argv)
  return args
}

function pushEnvironment(args: string[], env: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env)) {
    // The image's PATH names the toolchain baked into it; the host's names
    // directories that do not exist in the container.
    if (key === 'PATH') continue
    args.push('--env', `${key}=${value}`)
  }
}

/**
 * The same cell under Apple container, in its spelling, following the
 * thread-in-container runtime's mapping (`appleCreateArgs` in
 * `src/main/services/container-runtime/thread-container.ts`, and
 * `docs/plans/thread-in-container.md`, "Apple container as the host engine"):
 *
 * - no-new-privileges: Apple container has no flag, so the command runs under
 *   `setpriv --no-new-privs`, and `Dockerfile.cell` strips every setuid and
 *   setgid bit at build time and fails without `setpriv`.
 * - pids limit: no cgroup flag, so `RLIMIT_NPROC` on the cell's uid.
 * - seccomp: none; the boundary is the container's own VM.
 * - `--network none` leaves only loopback (measured by the thread runtime: the
 *   gateway, the host and the internet are unreachable and DNS fails).
 * - bind mounts are `--volume source:target[:ro]`, at the same host paths.
 * - no `--rm` and no pull flag: the backend deletes every container itself,
 *   and detection refuses an image the engine does not already hold.
 */
export function appleCreateArgs(input: ContainerRunInput): string[] {
  const pids = String(input.limits.pids)
  const args = ['create', '--name', input.name]
  for (const [key, value] of Object.entries(input.labels)) args.push('--label', `${key}=${value}`)
  args.push(
    '--init',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--ulimit',
    `nproc=${pids}:${pids}`,
    '--memory',
    input.limits.memory,
    '--cpus',
    String(input.limits.cpus),
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777',
    '--network',
    'none',
  )
  if (input.user !== null)
    args.push('--user', `${String(input.user.uid)}:${String(input.user.gid)}`)
  for (const path of new Set(input.writable)) args.push('--volume', `${path}:${path}`)
  for (const path of new Set(input.readOnly)) args.push('--volume', `${path}:${path}:ro`)
  args.push('--workdir', input.cwd)
  pushEnvironment(args, input.env)
  args.push('--entrypoint', 'setpriv', input.image, '--no-new-privs', '--', ...input.argv)
  return args
}

/** Maximum time to remove a container before terminating the attach client too. */
const KILL_GRACE_MS = 5_000

class ContainerCell implements ExecutionCell {
  readonly spec: CellSpec
  private readonly options: ContainerBackendOptions
  private readonly engine: ContainerEngine
  private readonly dialect: ContainerDialect
  private readonly spawn: SpawnEngine
  private readonly cellId: string
  private readonly homeDir: string
  private readonly tmpDir: string
  private readonly env: Readonly<Record<string, string>>
  private readonly live = new Map<
    string,
    {
      controller: AbortController
      done: Promise<CellCommandResult>
    }
  >()
  private sequence = 0
  private destroyed = false

  constructor(spec: CellSpec, options: ContainerBackendOptions, homeDir: string, tmpDir: string) {
    this.spec = spec
    this.options = options
    this.engine = options.engine ?? DEFAULT_CONTAINER_ENGINE
    this.dialect = options.dialect ?? 'docker'
    this.spawn = options.spawn ?? nodeSpawn
    this.cellId = randomBytes(4).toString('hex')
    this.homeDir = homeDir
    this.tmpDir = tmpDir
    this.env = { ...spec.env, HOME: homeDir, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir }
  }

  private engineArgv(args: readonly string[]): [string, string[]] {
    const [file, ...prefix] = this.engine
    return [file, [...prefix, ...args]]
  }

  private runInput(command: CellCommand, commandId: string): ContainerRunInput {
    const name = this.options.containerName?.(commandId) ?? `copse-review-${commandId}`
    return {
      name,
      image: this.options.image,
      labels: this.options.labels?.(commandId) ?? {},
      user: this.options.user === undefined ? hostUser() : this.options.user,
      limits: { ...DEFAULT_CONTAINER_LIMITS, ...this.options.limits },
      writable: [this.spec.checkouts.base, this.spec.checkouts.head, this.spec.scratchDir],
      readOnly: this.spec.readOnlyPaths,
      cwd: this.spec.checkouts[command.target],
      env: this.env,
      argv: command.argv,
    }
  }

  private async remove(name: string): Promise<void> {
    const verb = this.dialect === 'apple' ? 'delete' : 'rm'
    const [file, args] = this.engineArgv([verb, '--force', name])
    const result = await probeEngine(this.spawn, file, args, KILL_GRACE_MS)
    // --rm may already have removed a naturally completed container; Apple
    // container says "not found" for one that is already gone.
    if (
      !result.ok &&
      !/no such container|no container with (?:name|ID)|not found/i.test(result.reason)
    ) {
      throw new Error(`Could not remove review container ${name}: ${result.reason}`)
    }
  }

  private async execute(
    input: ContainerRunInput,
    command: CellCommand,
  ): Promise<CellCommandResult> {
    const started = Date.now()
    const [file, args] = this.engineArgv(containerCreateArgs(input, this.dialect))
    let removal: Promise<void> | undefined
    const remove = (): Promise<void> => (removal ??= this.remove(input.name))
    try {
      // Creating a container cannot execute the checkout. Let creation settle
      // before cancellation removes it, so an early abort cannot miss a name
      // that a still-running engine client creates later.
      const created = await collectProcess(
        this.spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
        {
          ...command,
          signal: undefined,
          timeoutMs: Math.min(command.timeoutMs || DETECT_TIMEOUT_MS, DETECT_TIMEOUT_MS),
        },
      )
      command.signal?.throwIfAborted()
      if (created.exitCode !== 0 || created.timedOut) return created
      const remaining = command.timeoutMs - (Date.now() - started)
      if (command.timeoutMs > 0 && remaining <= 0) {
        return { ...created, exitCode: null, timedOut: true }
      }
      const [startFile, startArgs] = this.engineArgv(['start', '--attach', input.name])
      const child = this.spawn(startFile, startArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      const result = await collectProcess(
        child,
        {
          ...command,
          timeoutMs: command.timeoutMs > 0 ? remaining : 0,
        },
        {
          kill: () => {
            // Cleanup is awaited below even if the client has already exited.
            // A daemon failure must also stop the attach client from hanging.
            void remove().catch(() => undefined)
            if (child.exitCode !== null || child.signalCode !== null) return
            const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
            timer.unref()
            child.once('close', () => {
              clearTimeout(timer)
            })
          },
        },
      )
      return { ...result, durationMs: Date.now() - started }
    } finally {
      await remove()
    }
  }

  async run(command: CellCommand): Promise<CellCommandResult> {
    command.signal?.throwIfAborted()
    if (this.destroyed) throw new Error('Review cell has been destroyed')
    const commandId = `${this.cellId}-${String(++this.sequence)}`
    const input = this.runInput(command, commandId)
    const controller = new AbortController()
    const signal =
      command.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, command.signal])
    const done = this.execute(input, { ...command, signal })
    this.live.set(input.name, { controller, done })
    try {
      return await done
    } finally {
      this.live.delete(input.name)
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    const commands = [...this.live.values()]
    for (const { controller } of commands) controller.abort(new Error('Review cell destroyed'))
    await Promise.all(commands.map(({ done }) => done.catch(() => undefined)))
    this.live.clear()
    await removeTree(this.homeDir)
    await removeTree(this.tmpDir)
  }
}

function hostUser(): ContainerUser | null {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  return uid === undefined || gid === undefined ? null : { uid, gid }
}

/** A container backend over `options.image`. Does not check that the engine or the image exist; see {@link detectContainerBackend}. */
export function createContainerBackend(options: ContainerBackendOptions): IsolationBackend {
  return {
    id: CONTAINER_BACKEND_ID,
    strength: 'container',
    capabilities: {
      filesystemConfined: true,
      secretFreeEnvironment: true,
      networkDenied: true,
      ephemeral: true,
    },
    async createCell(spec: CellSpec): Promise<ExecutionCell> {
      const homeDir = join(spec.scratchDir, 'home')
      const tmpDir = join(spec.scratchDir, 'tmp')
      await mkdir(homeDir, { recursive: true })
      await mkdir(tmpDir, { recursive: true })
      return new ContainerCell(spec, options, homeDir, tmpDir)
    },
  }
}

export interface DetectContainerBackendOptions extends Omit<
  ContainerBackendOptions,
  'engine' | 'dialect'
> {
  /** Engines to try, in order. Default: {@link defaultContainerEngines}. */
  readonly engines?: readonly ContainerEngineCandidate[]
  readonly timeoutMs?: number
}

export type ContainerDetection =
  | {
      readonly backend: IsolationBackend
      readonly engine: ContainerEngineCandidate
      readonly reason: null
    }
  | { readonly backend: null; readonly engine: null; readonly reason: string }

const DETECT_TIMEOUT_MS = 15_000

/** The variable that names an engine; the same one Copse's other container work reads. */
export const CONTAINER_ENGINE_ENV = 'COPSE_CONTAINER_ENGINE'

export const CONTAINER_ENGINE_PREFERENCES = ['auto', 'docker', 'podman', 'apple'] as const
export type ContainerEnginePreference = (typeof CONTAINER_ENGINE_PREFERENCES)[number]
const isContainerEnginePreference = memberOf(CONTAINER_ENGINE_PREFERENCES)

/** Whether this host can run Apple container: Apple silicon under macOS. */
export function canRunAppleContainer(platform: NodeJS.Platform, arch: string): boolean {
  return platform === 'darwin' && arch === 'arm64'
}

/**
 * The engines detection tries, in order. `COPSE_CONTAINER_ENGINE` names one
 * (`docker`, `podman`, `apple`) and is then the only one tried; `auto` (the
 * default) tries Docker, then Podman, then — on Apple silicon — Apple container.
 */
export function defaultContainerEngines(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly platform?: NodeJS.Platform
    readonly arch?: string
  } = {},
): ContainerEngineCandidate[] {
  const env = options.env ?? process.env
  const raw = env[CONTAINER_ENGINE_ENV]?.trim().toLowerCase() ?? ''
  const preference = raw === '' ? 'auto' : raw
  if (!isContainerEnginePreference(preference)) {
    throw new Error(
      `Unsupported ${CONTAINER_ENGINE_ENV}=${JSON.stringify(raw)}; use ${CONTAINER_ENGINE_PREFERENCES.join(', ')}`,
    )
  }
  const apple = canRunAppleContainer(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  )
  switch (preference) {
    case 'docker':
      return [DOCKER_ENGINE]
    case 'podman':
      return [PODMAN_ENGINE]
    case 'apple':
      return [APPLE_CONTAINER_ENGINE]
    case 'auto':
      return apple
        ? [DOCKER_ENGINE, PODMAN_ENGINE, APPLE_CONTAINER_ENGINE]
        : [DOCKER_ENGINE, PODMAN_ENGINE]
  }
}

/** The argv (after the engine's own) that succeeds only when the engine holds `image`. */
export function imageInspectArgs(dialect: ContainerDialect, image: string): string[] {
  // Apple container's inspect prints JSON and takes no Go template.
  return dialect === 'apple'
    ? ['image', 'inspect', image]
    : ['image', 'inspect', '--format', '{{.Id}}', image]
}

/** Whether `engine` answers and already holds `image`, or why not. */
export function probeContainerImage(
  engine: ContainerEngineCandidate,
  image: string,
  options: { readonly spawn?: SpawnEngine; readonly timeoutMs?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [file, ...prefix] = engine.argv
  return probeEngine(
    options.spawn ?? nodeSpawn,
    file,
    [...prefix, ...imageInspectArgs(engine.dialect, image)],
    options.timeoutMs ?? DETECT_TIMEOUT_MS,
  )
}

/**
 * The container backend when an engine is reachable and already holds the
 * image, else the reason it is not: no engine on PATH, a daemon that does not
 * answer, an image that was never built. Nothing is pulled — the image a
 * review runs from is one the operator chose and built, not one a name on the
 * network happens to resolve to.
 */
export async function detectContainerBackend(
  options: DetectContainerBackendOptions,
): Promise<ContainerDetection> {
  let engines: readonly ContainerEngineCandidate[]
  try {
    engines = options.engines ?? defaultContainerEngines()
  } catch (err) {
    return { backend: null, engine: null, reason: errorMessage(err) }
  }
  const reasons: string[] = []
  for (const engine of engines) {
    const probe = await probeContainerImage(engine, options.image, {
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    if (probe.ok) {
      const { engines: _engines, timeoutMs: _timeout, ...rest } = options
      return {
        backend: createContainerBackend({ ...rest, engine: engine.argv, dialect: engine.dialect }),
        engine,
        reason: null,
      }
    }
    reasons.push(`${engine.argv[0]}: ${probe.reason}`)
  }
  return { backend: null, engine: null, reason: reasons.join('; ') }
}

function probeEngine(
  spawn: SpawnEngine,
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, reason: errorMessage(err) })
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, reason: `did not answer within ${String(timeoutMs)} ms` })
    }, timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: /ENOENT/.test(err.message) ? 'not installed' : err.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true })
      else {
        const detail = stderr.trim().split('\n').at(-1) ?? ''
        resolve({ ok: false, reason: detail.length > 0 ? detail : `exit ${String(code)}` })
      }
    })
  })
}
