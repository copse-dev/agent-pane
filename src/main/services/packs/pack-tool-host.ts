import type { ChildProcess } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import {
  containedSandboxNetworkConfig,
  electronRuntimeAllowReadPaths,
} from '../../project-sandbox/config.ts'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  spawnInProjectSandbox,
} from '../../project-sandbox/spawn.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import {
  discoverPackToolSource,
  samePackToolSource,
  type PackToolSourceCandidate,
} from './pack-tool-source.ts'
import {
  PACK_TOOL_PROTOCOL_MAX_LINE_BYTES,
  zPackToolRegistrations,
  zPackToolWorkerMessage,
  type PackToolRegistrations,
} from './pack-tool-protocol.ts'
import { materializePackToolSnapshot } from './pack-tool-snapshot.ts'
import { errorMessage } from '@shared/errors.ts'
import { parseJsonUnknown } from '@shared/unknown-value.ts'

const INITIALIZE_TIMEOUT_MS = 15_000
const INVOCATION_TIMEOUT_MS = 5 * 60_000
const MAX_BUFFER_BYTES = PACK_TOOL_PROTOCOL_MAX_LINE_BYTES * 2

export class PackToolHostUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackToolHostUnavailable'
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

export interface PackToolHostDependencies {
  sandboxAvailable(): boolean
  materialize(candidate: PackToolSourceCandidate): Promise<PackToolSourceCandidate>
  spawn(candidate: PackToolSourceCandidate, workerPath: string): Promise<ChildProcess>
}

function protectedReadRoots(): string[] {
  const roots = new Set([homedir(), tmpdir(), '/Users', '/Volumes', '/private/tmp'])
  if (process.platform === 'darwin') roots.add('/private/var/folders')
  return [...roots]
}

/** The worker can read only its immutable snapshot and runtime, with no network or writes. */
export function packToolSandboxOverlay(
  sourcePath: string,
  workerPath: string,
): Partial<SandboxRuntimeConfig> {
  const source = resolve(sourcePath)
  const workerDirectory = dirname(resolve(workerPath))
  return {
    network: containedSandboxNetworkConfig(),
    filesystem: {
      denyRead: protectedReadRoots(),
      allowRead: [
        source,
        `${source}/**`,
        workerDirectory,
        `${workerDirectory}/**`,
        ...electronRuntimeAllowReadPaths(),
      ],
      allowWrite: [],
      denyWrite: [],
      allowGitConfig: false,
    },
  }
}

export function packToolWorkerPath(): string {
  return join(__dirname, 'pack-tool-worker.js')
}

const defaultDependencies: PackToolHostDependencies = {
  sandboxAvailable: isProjectSandboxEnabled,
  materialize: materializePackToolSnapshot,
  spawn(candidate, workerPath) {
    return spawnInProjectSandbox(process.execPath, [workerPath], {
      cwd: candidate.sourcePath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      sandboxConfig: packToolSandboxOverlay(candidate.sourcePath, workerPath),
    })
  },
}

export class PackToolHost {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly proc: ChildProcess
  private buffer = ''
  private nextId = 1
  private alive = true

  private constructor(proc: ChildProcess) {
    this.proc = proc
  }

  static async start(
    expectedCandidate: PackToolSourceCandidate,
    dependencies: PackToolHostDependencies = defaultDependencies,
  ): Promise<PackToolHost> {
    if (!dependencies.sandboxAvailable()) {
      throw new PackToolHostUnavailable(
        'Executable pack tools require Copse’s active OS sandbox; execution failed closed.',
      )
    }

    // Re-read immediately before snapshotting. The hash is an execution-consistency
    // boundary, not a second user approval: a concurrent edit simply retries later.
    const candidate = await discoverPackToolSource(expectedCandidate.sourcePath)
    if (!samePackToolSource(expectedCandidate, candidate)) {
      throw new PackToolHostUnavailable('Pack content changed while its tools were starting.')
    }

    const snapshot = await dependencies.materialize(candidate)
    if (!samePackToolSource(candidate, { ...snapshot, sourcePath: candidate.sourcePath })) {
      throw new PackToolHostUnavailable('Pack snapshot does not match the selected source.')
    }

    const workerPath = packToolWorkerPath()
    const proc = await dependencies.spawn(snapshot, workerPath)
    if (!proc.stdin || !proc.stdout) {
      terminateProcessTree(proc)
      throw new PackToolHostUnavailable('Pack tool worker pipes are unavailable.')
    }
    const host = new PackToolHost(proc)
    host.attach()
    try {
      const result = await host.request(
        {
          op: 'initialize',
          packId: snapshot.manifest.name,
          entrypoint: join(snapshot.sourcePath, snapshot.toolRuntime.entrypoint),
          apiVersion: snapshot.toolRuntime.apiVersion,
        },
        INITIALIZE_TIMEOUT_MS,
      )
      host.registrations = zPackToolRegistrations.parse(result)
      return host
    } catch (err) {
      host.fail(new PackToolHostUnavailable(errorMessage(err)))
      throw err
    }
  }

  registrations: PackToolRegistrations = { tools: [] }

  private attach(): void {
    const stdout = this.proc.stdout
    if (!stdout) return
    stdout.setEncoding('utf-8')
    stdout.on('data', (chunk: string) => {
      this.onData(chunk)
    })
    this.proc.on('exit', () => {
      this.fail(new PackToolHostUnavailable('Pack tool worker exited.'))
    })
    this.proc.on('error', (err) => {
      this.fail(new PackToolHostUnavailable(err.message))
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf-8') > MAX_BUFFER_BYTES) {
      this.fail(new PackToolHostUnavailable('Pack tool response exceeded its limit.'))
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf-8') > PACK_TOOL_PROTOCOL_MAX_LINE_BYTES) {
      this.fail(new PackToolHostUnavailable('Pack tool response line was too large.'))
      return
    }
    let raw: unknown
    try {
      raw = parseJsonUnknown(line)
    } catch {
      this.fail(new PackToolHostUnavailable('Pack tool returned invalid JSON.'))
      return
    }
    const parsed = zPackToolWorkerMessage.safeParse(raw)
    if (!parsed.success) {
      this.fail(new PackToolHostUnavailable('Pack tool returned invalid protocol data.'))
      return
    }
    const message = parsed.data
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    this.clearPending(pending)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error ?? 'Pack tool request failed.'))
  }

  private request(
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.alive || !this.proc.stdin || this.proc.stdin.destroyed) {
      return Promise.reject(new PackToolHostUnavailable('Pack tools are not running.'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        this.clearPending(pending)
        reject(new PackToolHostUnavailable('Pack tool request timed out.'))
      }, timeoutMs)
      timer.unref()
      const onAbort = (): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        this.clearPending(pending)
        reject(new Error('Pack tool request was cancelled.'))
        void this.request({ op: 'cancel', targetRequestId: id }, INITIALIZE_TIMEOUT_MS).catch(
          () => {},
        )
      }
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(signal ? { signal, onAbort } : {}),
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      try {
        const line = `${JSON.stringify({ id, ...body })}\n`
        if (Buffer.byteLength(line, 'utf-8') > PACK_TOOL_PROTOCOL_MAX_LINE_BYTES) {
          throw new Error('Pack tool request exceeded its limit.')
        }
        this.proc.stdin?.write(line, (err) => {
          if (!err) return
          const pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          this.clearPending(pending)
          reject(new PackToolHostUnavailable(err.message))
        })
      } catch (err) {
        const pending = this.pending.get(id)
        this.pending.delete(id)
        if (pending) this.clearPending(pending)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private clearPending(pending: PendingRequest): void {
    clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
  }

  invoke(registrationId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request({ op: 'invoke', registrationId, input }, INVOCATION_TIMEOUT_MS, signal)
  }

  async stop(): Promise<void> {
    if (!this.alive) return
    await this.request({ op: 'shutdown' }, INITIALIZE_TIMEOUT_MS).catch(() => {})
    this.fail(new PackToolHostUnavailable('Pack tools stopped.'))
  }

  private fail(error: Error): void {
    if (!this.alive) return
    this.alive = false
    for (const pending of this.pending.values()) {
      this.clearPending(pending)
      pending.reject(error)
    }
    this.pending.clear()
    try {
      this.proc.stdin?.end()
    } catch {
      // already closed
    }
    terminateProcessTree(this.proc)
    afterSandboxedCommand()
  }
}
