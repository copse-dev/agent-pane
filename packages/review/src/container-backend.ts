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
// start, `<engine> kill` ends a timed-out command and everything it forked in
// one stroke, and nothing in the cell survives between commands except what it
// wrote to its mounted checkouts and scratch — which is the plan's "lifetime"
// row. The engine is Docker by default; Podman speaks the same argv.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '@copse/std/errors.ts'
import type {
  CellCommand,
  CellCommandResult,
  CellSpec,
  ExecutionCell,
  IsolationBackend,
} from './isolation.ts'
import { collectProcess } from './process-collect.ts'

export const CONTAINER_BACKEND_ID = 'container'

/** The engine's argv prefix: `['docker']`, `['podman']`, or a test's stand-in. */
export type ContainerEngine = readonly [string, ...string[]]

export const DEFAULT_CONTAINER_ENGINE: ContainerEngine = ['docker']

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

/** Everything `containerRunArgs` needs; pure in these values. */
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
 * The `run` argv for one command. Every wall the backend claims through its
 * capabilities is a flag here and nowhere else, pinned by a unit test, so the
 * declaration and the container cannot drift apart.
 */
export function containerRunArgs(input: ContainerRunInput): string[] {
  const args = ['run', '--rm', '--name', input.name]
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
  for (const path of input.writable) {
    args.push(`--mount=type=bind,source=${path},target=${path}`)
  }
  for (const path of input.readOnly) {
    args.push(`--mount=type=bind,source=${path},target=${path},readonly`)
  }
  args.push('--workdir', input.cwd)
  for (const [key, value] of Object.entries(input.env)) {
    // The image's PATH names the toolchain baked into it; the host's names
    // directories that do not exist in the container.
    if (key === 'PATH') continue
    args.push('--env', `${key}=${value}`)
  }
  args.push(input.image, ...input.argv)
  return args
}

/** How long the engine's kill gets before the client process is killed as a fallback. */
const KILL_GRACE_MS = 5_000

class ContainerCell implements ExecutionCell {
  readonly spec: CellSpec
  private readonly options: ContainerBackendOptions
  private readonly engine: ContainerEngine
  private readonly spawn: SpawnEngine
  private readonly cellId: string
  private readonly homeDir: string
  private readonly tmpDir: string
  private readonly env: Readonly<Record<string, string>>
  private readonly live = new Map<string, ChildProcess>()
  private sequence = 0
  private destroyed = false

  constructor(spec: CellSpec, options: ContainerBackendOptions, homeDir: string, tmpDir: string) {
    this.spec = spec
    this.options = options
    this.engine = options.engine ?? DEFAULT_CONTAINER_ENGINE
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

  /**
   * End a command: ask the engine to kill its container (which ends every
   * process in it and, with `--rm`, removes it), and if the client has not
   * followed within the grace period, kill the client too. A client that has
   * already exited needs neither.
   */
  private kill(name: string, child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    const [file, args] = this.engineArgv(['kill', '--signal', 'KILL', name])
    const killer = this.spawn(file, args, { stdio: 'ignore' })
    killer.on('error', () => {
      // The engine itself is gone; the client kill below is what is left.
    })
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, KILL_GRACE_MS).unref()
  }

  async run(command: CellCommand): Promise<CellCommandResult> {
    command.signal?.throwIfAborted()
    if (this.destroyed) throw new Error('Review cell has been destroyed')
    const commandId = `${this.cellId}-${String(++this.sequence)}`
    const input = this.runInput(command, commandId)
    const [file, args] = this.engineArgv(containerRunArgs(input))
    const child = this.spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.live.set(input.name, child)
    try {
      const result = await collectProcess(child, command, {
        kill: (client) => {
          this.kill(input.name, client)
        },
      })
      // The engine's own failures (125: the daemon refused the run; 126/127:
      // the entrypoint could not run) come back as the command's exit code,
      // so a check that could not even start is a failed check, never a pass.
      return result
    } finally {
      this.live.delete(input.name)
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    const closed = [...this.live.values()].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }
          child.once('close', () => {
            resolve()
          })
        }),
    )
    for (const [name, child] of this.live) this.kill(name, child)
    await Promise.all(closed)
    this.live.clear()
    await rm(this.homeDir, { recursive: true, force: true })
    await rm(this.tmpDir, { recursive: true, force: true })
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

export interface DetectContainerBackendOptions extends Omit<ContainerBackendOptions, 'engine'> {
  /** Engines to try, in order. Default: Docker, then Podman. */
  readonly engines?: readonly ContainerEngine[]
  readonly timeoutMs?: number
}

export type ContainerDetection =
  | { readonly backend: IsolationBackend; readonly engine: ContainerEngine; readonly reason: null }
  | { readonly backend: null; readonly engine: null; readonly reason: string }

const DETECT_TIMEOUT_MS = 15_000

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
  const spawn = options.spawn ?? nodeSpawn
  const engines = options.engines ?? [DEFAULT_CONTAINER_ENGINE, ['podman']]
  const reasons: string[] = []
  for (const engine of engines) {
    const [file, ...prefix] = engine
    const probe = await probeEngine(
      spawn,
      file,
      [...prefix, 'image', 'inspect', '--format', '{{.Id}}', options.image],
      options.timeoutMs ?? DETECT_TIMEOUT_MS,
    )
    if (probe.ok) {
      const { engines: _engines, timeoutMs: _timeout, ...rest } = options
      return { backend: createContainerBackend({ ...rest, engine }), engine, reason: null }
    }
    reasons.push(`${file}: ${probe.reason}`)
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
