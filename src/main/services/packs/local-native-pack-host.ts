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
  discoverLocalNativePack,
  localNativePackTrustMatches,
  type LocalNativeCapability,
  type LocalNativePackCandidate,
  type LocalNativePackTrustRecord,
} from './local-native-pack.ts'
import {
  LOCAL_NATIVE_PROTOCOL_MAX_LINE_BYTES,
  zLocalNativeRegistrations,
  zLocalNativeWorkerMessage,
  type LocalNativeRegistrations,
} from './local-native-pack-protocol.ts'
import { materializeLocalNativePackSnapshot } from './local-native-pack-snapshot.ts'
import { errorMessage } from '@shared/errors.ts'
import { parseJsonUnknown } from '@shared/unknown-value.ts'

const INITIALIZE_TIMEOUT_MS = 15_000
const INVOCATION_TIMEOUT_MS = 5 * 60_000
const MAX_BUFFER_BYTES = LOCAL_NATIVE_PROTOCOL_MAX_LINE_BYTES * 2

export class LocalNativePackHostUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalNativePackHostUnavailable'
  }
}

export interface LocalNativePackHostCall {
  readonly packId: string
  readonly capability: LocalNativeCapability
  readonly method: string
  readonly args: unknown
}

export type LocalNativePackHostCallHandler = (call: LocalNativePackHostCall) => Promise<unknown>

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

export interface LocalNativePackHostDependencies {
  sandboxAvailable(): boolean
  materialize(candidate: LocalNativePackCandidate): Promise<LocalNativePackCandidate>
  spawn(candidate: LocalNativePackCandidate, workerPath: string): Promise<ChildProcess>
}

function protectedReadRoots(): string[] {
  const roots = new Set([homedir(), tmpdir(), '/Users', '/Volumes', '/private/tmp'])
  if (process.platform === 'darwin') roots.add('/private/var/folders')
  return [...roots]
}

/**
 * A native pack can read its own immutable payload and the bundled worker
 * runtime. It receives no direct network and no writable filesystem paths;
 * approved origins are exercised only through host calls that re-check the
 * pack identity and capability.
 */
export function localNativePackSandboxOverlay(
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

export function localNativePackWorkerPath(): string {
  return join(__dirname, 'local-native-pack-worker.js')
}

const defaultDependencies: LocalNativePackHostDependencies = {
  sandboxAvailable: isProjectSandboxEnabled,
  materialize: materializeLocalNativePackSnapshot,
  spawn(candidate, workerPath) {
    return spawnInProjectSandbox(process.execPath, [workerPath], {
      cwd: candidate.sourcePath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      sandboxConfig: localNativePackSandboxOverlay(candidate.sourcePath, workerPath),
    })
  },
}

export class LocalNativePackHost {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly capabilities: ReadonlySet<LocalNativeCapability>
  private readonly candidate: LocalNativePackCandidate
  private readonly proc: ChildProcess
  private readonly hostCallHandler: LocalNativePackHostCallHandler
  private buffer = ''
  private nextId = 1
  private alive = true

  private constructor(
    candidate: LocalNativePackCandidate,
    proc: ChildProcess,
    hostCallHandler: LocalNativePackHostCallHandler,
  ) {
    this.candidate = candidate
    this.proc = proc
    this.hostCallHandler = hostCallHandler
    this.capabilities = new Set(candidate.runtime.capabilities)
  }

  static async start(
    approvedCandidate: LocalNativePackCandidate,
    trustRecord: LocalNativePackTrustRecord,
    hostCallHandler: LocalNativePackHostCallHandler,
    dependencies: LocalNativePackHostDependencies = defaultDependencies,
  ): Promise<LocalNativePackHost> {
    if (!dependencies.sandboxAvailable()) {
      throw new LocalNativePackHostUnavailable(
        'Local native packs require Copse’s active OS sandbox; execution failed closed.',
      )
    }

    // Re-read and hash immediately before spawn. A stale Settings snapshot can
    // never authorize bytes that no longer match its exact trust record.
    const candidate = await discoverLocalNativePack(approvedCandidate.sourcePath)
    if (!localNativePackTrustMatches(candidate, trustRecord)) {
      throw new LocalNativePackHostUnavailable(
        'Local native pack source or requested authority changed after approval.',
      )
    }

    const snapshot = await dependencies.materialize(candidate)
    const approvedSnapshot = { ...snapshot, sourcePath: candidate.sourcePath }
    if (!localNativePackTrustMatches(approvedSnapshot, trustRecord)) {
      throw new LocalNativePackHostUnavailable(
        'Local native pack snapshot does not match the exact reviewed content and authority.',
      )
    }

    const workerPath = localNativePackWorkerPath()
    const proc = await dependencies.spawn(snapshot, workerPath)
    if (!proc.stdin || !proc.stdout) {
      terminateProcessTree(proc)
      throw new LocalNativePackHostUnavailable('Local native pack worker pipes are unavailable.')
    }
    const host = new LocalNativePackHost(snapshot, proc, hostCallHandler)
    host.attach()
    try {
      const result = await host.request(
        {
          op: 'initialize',
          packId: snapshot.manifest.name,
          entrypoint: join(snapshot.sourcePath, snapshot.runtime.entrypoint),
          sdkVersion: snapshot.runtime.sdkVersion,
          capabilities: snapshot.runtime.capabilities,
        },
        INITIALIZE_TIMEOUT_MS,
      )
      host.registrations = zLocalNativeRegistrations.parse(result)
      return host
    } catch (err) {
      host.fail(new LocalNativePackHostUnavailable(errorMessage(err)))
      throw err
    }
  }

  registrations: LocalNativeRegistrations = { tools: [] }

  private attach(): void {
    const stdout = this.proc.stdout
    if (!stdout) return
    stdout.setEncoding('utf-8')
    stdout.on('data', (chunk: string) => {
      this.onData(chunk)
    })
    this.proc.on('exit', () => {
      this.fail(new LocalNativePackHostUnavailable('Local native pack worker exited.'))
    })
    this.proc.on('error', (err) => {
      this.fail(new LocalNativePackHostUnavailable(err.message))
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf-8') > MAX_BUFFER_BYTES) {
      this.fail(
        new LocalNativePackHostUnavailable('Local native pack response exceeded its limit.'),
      )
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
    if (Buffer.byteLength(line, 'utf-8') > LOCAL_NATIVE_PROTOCOL_MAX_LINE_BYTES) {
      this.fail(
        new LocalNativePackHostUnavailable('Local native pack response line was too large.'),
      )
      return
    }
    let raw: unknown
    try {
      raw = parseJsonUnknown(line)
    } catch {
      this.fail(new LocalNativePackHostUnavailable('Local native pack returned invalid JSON.'))
      return
    }
    const parsed = zLocalNativeWorkerMessage.safeParse(raw)
    if (!parsed.success) {
      this.fail(
        new LocalNativePackHostUnavailable('Local native pack returned invalid protocol data.'),
      )
      return
    }
    const message = parsed.data
    if (message.type === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      this.clearPending(pending)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error ?? 'Local native pack request failed.'))
      return
    }
    void this.handleHostCall(message.id, message.capability, message.method, message.args)
  }

  private async handleHostCall(
    hostCallId: number,
    capability: LocalNativeCapability,
    method: string,
    args: unknown,
  ): Promise<void> {
    if (!this.capabilities.has(capability)) {
      this.writeHostCallResult(
        hostCallId,
        false,
        undefined,
        `Capability not approved: ${capability}`,
      )
      return
    }
    try {
      const result = await this.hostCallHandler({
        packId: this.candidate.manifest.name,
        capability,
        method,
        args,
      })
      this.writeHostCallResult(hostCallId, true, result)
    } catch (err) {
      this.writeHostCallResult(hostCallId, false, undefined, errorMessage(err))
    }
  }

  private writeHostCallResult(
    hostCallId: number,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    if (!this.alive || !this.proc.stdin || this.proc.stdin.destroyed) return
    try {
      this.proc.stdin.write(
        `${JSON.stringify({
          id: this.nextId++,
          op: 'host-call-result',
          hostCallId,
          ok,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error: error.slice(0, 8_192) } : {}),
        })}\n`,
      )
    } catch (err) {
      this.fail(new LocalNativePackHostUnavailable(errorMessage(err)))
    }
  }

  private request(
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.alive || !this.proc.stdin || this.proc.stdin.destroyed) {
      return Promise.reject(new LocalNativePackHostUnavailable('Local native pack is not running.'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        this.clearPending(pending)
        reject(new LocalNativePackHostUnavailable('Local native pack request timed out.'))
      }, timeoutMs)
      timer.unref()
      const onAbort = (): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        this.clearPending(pending)
        reject(new Error('Local native pack request was cancelled.'))
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
        if (Buffer.byteLength(line, 'utf-8') > LOCAL_NATIVE_PROTOCOL_MAX_LINE_BYTES) {
          throw new Error('Local native pack request exceeded its limit.')
        }
        this.proc.stdin?.write(line, (err) => {
          if (!err) return
          const pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          this.clearPending(pending)
          reject(new LocalNativePackHostUnavailable(err.message))
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

  async invoke(
    kind: 'tool',
    registrationId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      { op: 'invoke', kind, registrationId, input },
      INVOCATION_TIMEOUT_MS,
      signal,
    )
  }

  async stop(): Promise<void> {
    if (!this.alive) return
    await this.request({ op: 'shutdown' }, INITIALIZE_TIMEOUT_MS).catch(() => {})
    this.fail(new LocalNativePackHostUnavailable('Local native pack stopped.'))
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
