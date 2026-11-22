/**
 * One code-cell container: the hardened guest that runs a thread's cells, and
 * the host's end of its stdio link.
 *
 * The container has no network interface, a read-only root, no capabilities,
 * no host mounts and an unprivileged uid, and it is created with limits on
 * processes, memory and CPU. Its only way out is the link, on which the host
 * answers exactly two stream names (`code-cell-wire.ts`) and refuses the rest.
 * Tool requests are served only while a cell runs, and each must name that
 * cell; between cells every request is refused. (Code a cell leaves behind,
 * such as a timer, can still call tools while a later cell of the same thread
 * runs, under that cell's turn and call budget: the guest is one process.)
 *
 * The host treats the guest as hostile. Besides the size and schema checks on
 * every message, it bounds what the guest can make it do: requests in flight,
 * the bytes it may send per second, and how much the host will queue for a
 * guest that stops reading. Passing a bound stops and removes the container.
 *
 * Cells run one at a time. A cell that overruns its deadline, a cancelled one
 * and a link that fails all leave the container `broken`: its process may
 * still be busy with that cell, so the pool discards it rather than handing
 * the thread a container in an unknown state.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { errorMessage } from '@shared/errors.ts'
import { engineCommand, type ThreadContainerEngine } from '../container-runtime/container-engine.ts'
import { EgressLink, type MuxStream } from '../container-runtime/egress-link.ts'
import {
  containerName,
  decodeAppleInspect,
  MANAGED_LABEL,
  memoryBytes,
  RUNTIME_LABEL,
  runEngine,
  STORE_ROLE_LABEL,
  teardownRuntime,
} from '../container-runtime/thread-container.ts'
import { CODE_CELL_UID } from './code-cell-image.ts'
import {
  CODE_CELL_CONTROL_TARGET,
  CODE_CELL_TOOL_TARGET,
  cellResultSchema,
  decodeLine,
  encodeLine,
  guestReadySchema,
  readLines,
  readMessage,
  toolCallRequestSchema,
  type CellResult,
  type ToolCallResponse,
} from './code-cell-wire.ts'

/** The role label every code-cell container carries, beside the managed-runtime labels. */
export const CODE_CELL_ROLE = 'code-cell'
/** Code-cell runtime ids start with this, so a sweep can tell them from run containers. */
export const CODE_CELL_RUNTIME_PREFIX = 'cell-'

/** How long a new container has to say it is ready. */
const READY_TIMEOUT_MS = 30_000
/** How long past a cell's own deadline the host waits for the guest's answer. */
const RESULT_GRACE_MS = 2_000
/** The largest tool request a guest may send. */
const TOOL_REQUEST_LIMIT = 1024 * 1024
/** How many lines of the container's log are kept for diagnosing a failure. */
const LOG_TAIL_LINES = 40
/** How many tool requests a guest may have open at once. */
const MAX_OPEN_TOOL_STREAMS = 16
/** The most bytes a guest may send the host in one second. */
const INBOUND_BYTES_PER_SECOND = 32 * 1024 * 1024
/** The most frames the host will write to a guest in one second. */
const OUTBOUND_WRITES_PER_SECOND = 20_000
/** The most the host will queue for a guest that is not reading. */
const OUTBOUND_BACKLOG_BYTES = 64 * 1024 * 1024
const NO_CELL_RUNNING =
  'No cell is running: tools can only be called while the cell that asks is running.'

export interface CodeCellContainerSpec {
  engine: ThreadContainerEngine
  image: string
  runtimeId: string
  memoryLimit: string
  cpus: number
  pidsLimit: number
}

export const DEFAULT_CODE_CELL_LIMITS = {
  memoryLimit: '512m',
  cpus: 1,
  pidsLimit: 64,
} as const satisfies Pick<CodeCellContainerSpec, 'memoryLimit' | 'cpus' | 'pidsLimit'>

export function newCodeCellRuntimeId(): string {
  return `${CODE_CELL_RUNTIME_PREFIX}${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/**
 * The `create` argv for one code-cell container. Docker removes the container
 * itself when the runner exits (`--rm`), which it does as soon as the host's
 * end of the link closes, so an app that quits without tearing down leaves
 * nothing behind. Apple container gets the same guest in its own spelling and
 * is checked back from `container inspect` before use
 * ({@link appleCodeCellConfigShortfall}).
 */
export function codeCellCreateArgs(spec: CodeCellContainerSpec): string[] {
  const uid = String(CODE_CELL_UID)
  const labels = [
    '--label',
    `${MANAGED_LABEL}=1`,
    '--label',
    `${RUNTIME_LABEL}=${spec.runtimeId}`,
    '--label',
    `${STORE_ROLE_LABEL}=${CODE_CELL_ROLE}`,
  ]
  const tmp = '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'
  if (spec.engine === 'apple') {
    const pids = String(spec.pidsLimit)
    return [
      'create',
      '--interactive',
      '--name',
      containerName(spec.runtimeId),
      ...labels,
      '--init',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--ulimit',
      `nproc=${pids}:${pids}`,
      '--memory',
      spec.memoryLimit,
      '--cpus',
      String(spec.cpus),
      '--user',
      `${uid}:${uid}`,
      '--tmpfs',
      tmp,
      '--network',
      'none',
      spec.image,
    ]
  }
  return [
    'create',
    '--interactive',
    '--rm',
    '--name',
    containerName(spec.runtimeId),
    ...labels,
    '--init',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--pids-limit=${String(spec.pidsLimit)}`,
    `--memory=${spec.memoryLimit}`,
    // No swap beyond the memory limit (Docker otherwise allows as much again).
    `--memory-swap=${spec.memoryLimit}`,
    `--cpus=${String(spec.cpus)}`,
    `--user=${uid}:${uid}`,
    `--tmpfs=${tmp}`,
    '--network=none',
    // The link carries tool results (repository text): keep no copy on the
    // daemon's disk, and give a guest that writes endlessly nothing to fill.
    '--log-driver=none',
    '--stop-timeout=5',
    spec.image,
  ]
}

/**
 * Why the container Apple container created is not the one asked for, or
 * null. Apple container can accept an option and not apply it, so every
 * hardening property is read back from its recorded configuration.
 */
export function appleCodeCellConfigShortfall(
  spec: CodeCellContainerSpec,
  inspectJson: string,
): string | null {
  const container = decodeAppleInspect(inspectJson)
  if (container === null) return 'container inspect did not describe the container'
  const config = container.configuration
  const uid = String(CODE_CELL_UID)
  if (!config.capDrop.some((cap) => cap.toUpperCase() === 'ALL')) {
    return 'its Linux privileges were not all removed'
  }
  if (config.capAdd.length > 0) {
    return `it was given extra Linux privileges: ${config.capAdd.join(', ')}`
  }
  if (!config.readOnly) return 'the root filesystem is writable'
  if (config.networks.length > 0) return 'the container is attached to a network'
  if (config.initProcess.user.raw.userString !== `${uid}:${uid}`) {
    return `the runner runs as ${config.initProcess.user.raw.userString}`
  }
  const nproc = config.initProcess.rlimits.find((limit) => limit.limit === 'RLIMIT_NPROC')
  if (nproc?.soft !== spec.pidsLimit || nproc.hard !== spec.pidsLimit) {
    return 'the process limit was not applied'
  }
  if (config.resources.cpus !== spec.cpus) return 'the CPU limit was not applied'
  if (config.resources.memoryInBytes !== memoryBytes(spec.memoryLimit)) {
    return 'the memory limit was not applied'
  }
  if (config.ssh) return 'the host SSH agent is forwarded'
  if (config.virtualization) return 'nested virtualization is exposed'
  if (config.publishedPorts.length > 0 || config.publishedSockets.length > 0) {
    return 'a port or socket is published to the host'
  }
  if (!config.useInit) return 'the init process is missing'
  if (
    config.labels[MANAGED_LABEL] !== '1' ||
    config.labels[RUNTIME_LABEL] !== spec.runtimeId ||
    config.labels[STORE_ROLE_LABEL] !== CODE_CELL_ROLE
  ) {
    return 'the container is not labelled as this code cell'
  }
  for (const mount of config.mounts) {
    const tmpfs =
      mount.destination === '/tmp' &&
      Object.keys(mount.type).length === 1 &&
      Object.hasOwn(mount.type, 'tmpfs') &&
      mount.options.includes('rw') &&
      mount.options.includes('nosuid') &&
      mount.options.includes('nodev')
    if (!tmpfs) return `unexpected mount at ${mount.destination}`
  }
  if (!config.mounts.some((mount) => mount.destination === '/tmp')) {
    return 'the /tmp scratch mount is missing'
  }
  return null
}

/** The attached `start` process, as much of it as the container needs. */
export interface AttachedProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  once(event: 'exit', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface CodeCellContainerDependencies {
  runEngine: (engine: ThreadContainerEngine, args: string[]) => Promise<string>
  attach: (engine: ThreadContainerEngine, name: string) => AttachedProcess
  teardown: (runtimeId: string, engine: ThreadContainerEngine) => Promise<unknown>
}

const defaultDependencies: CodeCellContainerDependencies = {
  runEngine: (engine, args) => runEngine(engine, args),
  attach: (engine, name) =>
    spawn(engineCommand(engine), ['start', '--attach', '--interactive', name], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  teardown: (runtimeId, engine) => teardownRuntime(runtimeId, engine),
}

/** Answers one tool request from the running cell. Never throws: a failure is a refusal. */
export type CellToolHandler = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<ToolCallResponse>

export interface CellRequest {
  code: string
  timeoutMs: number
  signal: AbortSignal
  callTool: CellToolHandler
}

export type CellOutcome =
  | { kind: 'result'; result: CellResult }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: string }

interface ActiveCell {
  id: number
  controller: AbortController
  callTool: CellToolHandler
  settle: (outcome: CellOutcome) => void
}

export class CodeCellContainer {
  readonly spec: CodeCellContainerSpec
  private readonly deps: CodeCellContainerDependencies
  private readonly child: AttachedProcess
  private readonly link: EgressLink
  private control: MuxStream | null = null
  private ready: PromiseWithResolvers<void> = Promise.withResolvers()
  private active: ActiveCell | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private nextCell = 1
  private openToolStreams = 0
  private broken: string | null = null
  private stopping: Promise<void> | null = null
  private exited = false
  private readonly logTail: string[] = []
  private inboundWindow = { start: 0, bytes: 0 }
  private outboundWindow = { start: 0, writes: 0 }

  private constructor(
    spec: CodeCellContainerSpec,
    child: AttachedProcess,
    deps: CodeCellContainerDependencies,
  ) {
    this.spec = spec
    this.deps = deps
    this.child = child
    // Readiness is awaited by `start`; a failure after that has no one to tell.
    this.ready.promise.catch(() => {})
    child.stdin.on('error', () => {
      // EPIPE once the container is gone; the link's own close reports it.
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim().length === 0) continue
        this.logTail.push(line.slice(0, 500))
        if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift()
      }
    })
    child.once('exit', () => {
      this.exited = true
      this.fail('the container exited')
    })
    // A failed spawn (no engine CLI, no file descriptors) arrives as `error`
    // rather than `exit`; without a listener it would take the app down.
    child.on('error', (error) => {
      this.exited = true
      this.fail(`the engine could not be started: ${error.message}`)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      this.meterInbound(chunk.length)
    })
    const output = {
      write: (chunk: Buffer): boolean => this.writeToGuest(chunk),
      on: (event: 'drain' | 'error' | 'close', listener: (error?: Error) => void): void => {
        child.stdin.on(event, listener)
      },
    }
    this.link = new EgressLink(child.stdout, output, {
      onOpen: (id, target): void => {
        this.open(id, target)
      },
      onClose: (error): void => {
        this.fail(error ? `the link closed: ${error.message}` : 'the link closed')
      },
    })
  }

  /** Create and start a container, and resolve once its runner has said it is ready. */
  static async start(
    spec: CodeCellContainerSpec,
    deps: CodeCellContainerDependencies = defaultDependencies,
  ): Promise<CodeCellContainer> {
    try {
      // A `create` that timed out may still have made the container.
      await deps.runEngine(spec.engine, codeCellCreateArgs(spec))
      if (spec.engine === 'apple') {
        const inspect = await deps.runEngine('apple', ['inspect', containerName(spec.runtimeId)])
        const shortfall = appleCodeCellConfigShortfall(spec, inspect)
        if (shortfall !== null) {
          throw new Error(`Apple container did not apply the code-cell hardening: ${shortfall}`)
        }
      }
    } catch (error) {
      await deps.teardown(spec.runtimeId, spec.engine).catch(() => {})
      throw error
    }
    const container = new CodeCellContainer(
      spec,
      deps.attach(spec.engine, containerName(spec.runtimeId)),
      deps,
    )
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        container.ready.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `the code-cell container did not start within ${String(READY_TIMEOUT_MS)} ms`,
              ),
            )
          }, READY_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      await container.stop()
      throw new Error(`${errorMessage(error)}${container.describeLog()}`, { cause: error })
    } finally {
      clearTimeout(timer)
    }
    return container
  }

  /** Usable for another cell: started, not stopping, not left in an unknown state. */
  get alive(): boolean {
    return this.broken === null && this.stopping === null && !this.exited
  }

  /** Whether a cell is running or waiting to. */
  get busy(): boolean {
    return this.active !== null
  }

  /** Stop a guest that sends faster than any cell needs to. */
  private meterInbound(bytes: number): void {
    const now = Date.now()
    if (now - this.inboundWindow.start >= 1000) this.inboundWindow = { start: now, bytes: 0 }
    this.inboundWindow.bytes += bytes
    if (this.inboundWindow.bytes > INBOUND_BYTES_PER_SECOND) {
      this.overrun('the runner sent more than the link allows')
    }
  }

  /**
   * Every frame the host writes goes through here. A guest can make the host
   * answer (a PING, a refused OPEN) without reading the answers, so the
   * queue and the write rate are both bounded.
   */
  private writeToGuest(chunk: Buffer): boolean {
    if (this.broken !== null) return false
    const now = Date.now()
    if (now - this.outboundWindow.start >= 1000) this.outboundWindow = { start: now, writes: 0 }
    this.outboundWindow.writes += 1
    if (this.outboundWindow.writes > OUTBOUND_WRITES_PER_SECOND) {
      this.overrun('the runner asked for more than the link allows')
      return false
    }
    if (this.child.stdin.writableLength > OUTBOUND_BACKLOG_BYTES) {
      this.overrun('the runner stopped reading the link')
      return false
    }
    return this.child.stdin.write(chunk)
  }

  private overrun(reason: string): void {
    if (this.stopping !== null) return
    this.fail(reason)
    void this.stop()
  }

  private describeLog(): string {
    return this.logTail.length > 0 ? `\nContainer log:\n${this.logTail.join('\n')}` : ''
  }

  private fail(reason: string): void {
    this.broken ??= reason
    this.ready.reject(new Error(reason))
    // Settle the running cell, if any; its container cannot answer any more.
    this.active?.settle({ kind: 'failed', error: `${reason}${this.describeLog()}` })
  }

  private open(id: number, target: string): void {
    if (target === CODE_CELL_CONTROL_TARGET && this.control === null) {
      const control = this.link.accept(id)
      this.control = control
      control.on('error', () => {
        this.fail('the control stream failed')
      })
      readLines(control, (line) => {
        this.onControlLine(line)
      }).then(
        () => {
          this.fail('the control stream closed')
        },
        () => {
          this.fail('the control stream sent an oversized message')
        },
      )
      return
    }
    if (target === CODE_CELL_TOOL_TARGET && this.control !== null) {
      // Each open request may buffer up to TOOL_REQUEST_LIMIT here, so a guest
      // gets a bounded number at once, and none between cells.
      if (this.active === null || !this.alive) {
        this.link.refuse(id, NO_CELL_RUNNING)
        return
      }
      if (this.openToolStreams >= MAX_OPEN_TOOL_STREAMS) {
        this.link.refuse(
          id,
          `A cell may have at most ${String(MAX_OPEN_TOOL_STREAMS)} tool calls in flight at once.`,
        )
        return
      }
      this.openToolStreams += 1
      const stream = this.link.accept(id)
      // The guest can reset the stream at any moment, and a write after the
      // link closed fails: either surfaces as `error`, which must not be the
      // main process's uncaught exception. `serveTool` sees the stream end.
      stream.on('error', () => {})
      stream.once('close', () => {
        this.openToolStreams -= 1
      })
      void this.serveTool(stream)
      return
    }
    this.link.refuse(id, 'DENY not a code-cell stream')
  }

  private onControlLine(line: string): void {
    if (decodeLine(line, guestReadySchema) !== null) {
      this.ready.resolve()
      return
    }
    const result = decodeLine(line, cellResultSchema)
    if (result === null) {
      this.fail('the runner sent a malformed control message')
      this.link.close(new Error('malformed control message'))
      return
    }
    if (this.active?.id === result.id) this.active.settle({ kind: 'result', result })
  }

  private async serveTool(stream: MuxStream): Promise<void> {
    let reply: ToolCallResponse
    try {
      const request = decodeLine(
        (await readMessage(stream, TOOL_REQUEST_LIMIT)).trim(),
        toolCallRequestSchema,
      )
      const active = this.active
      if (request === null) reply = { ok: false, error: 'The tool request was malformed.' }
      else if (active === null || request.cell !== active.id) {
        reply = { ok: false, error: NO_CELL_RUNNING }
      } else {
        reply = await active.callTool(request.name, request.args, active.controller.signal)
      }
    } catch (error) {
      reply = { ok: false, error: errorMessage(error) }
    }
    if (stream.destroyed) return
    try {
      stream.end(encodeLine(reply))
    } catch (error) {
      stream.end(encodeLine({ ok: false, error: errorMessage(error) }))
    }
  }

  /**
   * Run one cell after any that were sent before it. Resolves with the cell's
   * outcome; anything but `result` leaves the container unusable.
   */
  runCell(request: CellRequest): Promise<CellOutcome> {
    const run = this.queue.then(() => this.runNow(request))
    this.queue = run.catch(() => {})
    return run
  }

  private runNow(request: CellRequest): Promise<CellOutcome> {
    if (!this.alive || this.control === null) {
      return Promise.resolve({
        kind: 'failed',
        error: this.broken ?? 'the code-cell container is not running',
      })
    }
    if (request.signal.aborted) return Promise.resolve({ kind: 'aborted' })
    const control = this.control
    const id = this.nextCell
    this.nextCell += 1
    const { promise, resolve } = Promise.withResolvers<CellOutcome>()
    const controller = new AbortController()
    const onAbort = (): void => {
      settle({ kind: 'aborted' })
    }
    const timer = setTimeout(() => {
      settle({ kind: 'timeout' })
    }, request.timeoutMs + RESULT_GRACE_MS)
    const settle = (outcome: CellOutcome): void => {
      if (this.active?.id !== id) return
      this.active = null
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      controller.abort()
      if (outcome.kind !== 'result') this.broken ??= `the cell ended as ${outcome.kind}`
      resolve(outcome)
    }
    this.active = { id, controller, callTool: request.callTool, settle }
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      control.write(encodeLine({ op: 'run', id, code: request.code, timeoutMs: request.timeoutMs }))
    } catch (error) {
      settle({ kind: 'failed', error: errorMessage(error) })
    }
    return promise
  }

  /** Close the link and remove the container. Idempotent; never throws. */
  stop(): Promise<void> {
    this.stopping ??= (async (): Promise<void> => {
      this.fail('the container was stopped')
      this.link.close(undefined)
      this.child.stdin.end()
      if (!this.exited) {
        // The attached start exits with the container, which exits when its
        // runner sees the link close. One that does not is killed; teardown
        // below removes the container either way.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.child.kill('SIGKILL')
            resolve()
          }, 5_000)
          this.child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      await this.deps.teardown(this.spec.runtimeId, this.spec.engine).catch((error: unknown) => {
        console.error(`[code-mode] could not remove ${containerName(this.spec.runtimeId)}:`, error)
      })
    })()
    return this.stopping
  }
}
