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
import { isProjectSandboxPlatform, projectSandboxInitFailure } from '../../project-sandbox/state.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'
import {
  discoverPackToolSource,
  samePackToolSource,
  type PackToolSourceCandidate,
} from './pack-tool-source.ts'
import {
  PACK_TOOL_PROTOCOL_MAX_LINE_BYTES,
  zPackModelTurn,
  zPackToolRegistrations,
  zPackToolWorkerMessage,
  type PackToolRegistrations,
  type PackBrowserCall,
} from './pack-tool-protocol.ts'
import {
  persistentPackThreadSessionStore,
  type PackThreadSessionStore,
} from './pack-thread-session-store.ts'
import { materializePackToolSnapshot } from './pack-tool-snapshot.ts'
import {
  getPackBrowserService,
  type PackBrowserOwner,
  type PackBrowserService,
} from './pack-browser-service.ts'
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
  threadId?: string
}

export interface PackToolHostDependencies {
  sandboxAvailable(): boolean
  materialize(candidate: PackToolSourceCandidate): Promise<PackToolSourceCandidate>
  spawn(candidate: PackToolSourceCandidate, workerPath: string): Promise<ChildProcess>
  sessionStore?: PackThreadSessionStore
  browserService?: PackBrowserService | null
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
  private readonly packId: string
  private readonly sessionStore: PackThreadSessionStore
  private readonly browserService: PackBrowserService | null
  private readonly allowedBrowserOrigins: readonly string[]
  private buffer = ''
  private nextId = 1
  private alive = true

  private constructor(
    proc: ChildProcess,
    packId: string,
    sessionStore: PackThreadSessionStore,
    browserService: PackBrowserService | null,
    allowedBrowserOrigins: readonly string[],
  ) {
    this.proc = proc
    this.packId = packId
    this.sessionStore = sessionStore
    this.browserService = browserService
    this.allowedBrowserOrigins = allowedBrowserOrigins
  }

  static async start(
    expectedCandidate: PackToolSourceCandidate,
    dependencies: PackToolHostDependencies = defaultDependencies,
  ): Promise<PackToolHost> {
    if (!dependencies.sandboxAvailable()) {
      // Name why the sandbox is absent, not just that it is. The two causes need
      // different fixes — an unsupported platform is a product limit, a failed
      // init is an environment fault — and without this the distinction lives
      // only in the main-process log.
      const cause = !isProjectSandboxPlatform()
        ? `No sandbox backend on ${process.platform}.`
        : (projectSandboxInitFailure() ?? 'Sandbox init did not run.')
      throw new PackToolHostUnavailable(
        `Executable pack behavior requires Copse’s active OS sandbox; execution failed closed. ${cause}`,
      )
    }

    // Re-read immediately before snapshotting. The hash is an execution-consistency
    // boundary, not a second user approval: a concurrent edit simply retries later.
    const candidate = await discoverPackToolSource(expectedCandidate.sourcePath)
    if (!samePackToolSource(expectedCandidate, candidate)) {
      throw new PackToolHostUnavailable('Pack content changed while its runtime was starting.')
    }

    const snapshot = await dependencies.materialize(candidate)
    if (!samePackToolSource(candidate, { ...snapshot, sourcePath: candidate.sourcePath })) {
      throw new PackToolHostUnavailable('Pack snapshot does not match the selected source.')
    }

    const workerPath = packToolWorkerPath()
    const proc = await dependencies.spawn(snapshot, workerPath)
    if (!proc.stdin || !proc.stdout) {
      terminateProcessTree(proc)
      throw new PackToolHostUnavailable('Pack runtime worker pipes are unavailable.')
    }
    const host = new PackToolHost(
      proc,
      snapshot.manifest.name,
      dependencies.sessionStore ?? persistentPackThreadSessionStore,
      dependencies.browserService === undefined
        ? getPackBrowserService()
        : dependencies.browserService,
      snapshot.manifest.browser?.origins ?? [],
    )
    host.attach()
    try {
      const result = await host.request(
        {
          op: 'initialize',
          packId: snapshot.manifest.name,
          entrypoint: join(snapshot.sourcePath, snapshot.runtime.entrypoint),
          apiVersion: snapshot.runtime.apiVersion,
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

  registrations: PackToolRegistrations = { tools: [], models: [] }

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
    if (message.type === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      this.clearPending(pending)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error ?? 'Pack runtime request failed.'))
      return
    }
    if (message.type === 'session-call') {
      void this.handleSessionCall(message.id, message.invocationId, message.op, message.state)
      return
    }
    void this.handleBrowserCall(message)
  }

  private browserOwner(invocationId: number): PackBrowserOwner {
    const invocation = this.pending.get(invocationId)
    if (!invocation?.threadId) throw new Error('No active model thread for browser access.')
    if (this.allowedBrowserOrigins.length === 0) {
      throw new Error('This pack declares no interactive browser origins.')
    }
    return {
      packId: this.packId,
      threadId: invocation.threadId,
      allowedOrigins: this.allowedBrowserOrigins,
    }
  }

  private async handleBrowserCall(call: PackBrowserCall): Promise<void> {
    const service = this.browserService
    if (!service) {
      this.writeBrowserResult(
        call.id,
        false,
        undefined,
        'The interactive browser pane is unavailable.',
      )
      return
    }
    try {
      const owner = this.browserOwner(call.invocationId)
      let result: unknown
      switch (call.op) {
        case 'open':
          result = await service.open(owner, call.url, call.newTab)
          break
        case 'navigate':
          result = await service.navigate(owner, call.tabId, call.url)
          break
        case 'tabs':
          result = service.tabs(owner)
          break
        case 'snapshot':
          result = await service.snapshot(owner, call.tabId)
          break
        case 'click':
          await service.click(owner, call.tabId, call.ref)
          result = null
          break
        case 'type':
          await service.type(owner, call.tabId, call.ref, call.text)
          result = null
          break
        case 'upload':
          await service.upload(owner, call.tabId, call.ref, call.files)
          result = null
          break
      }
      this.writeBrowserResult(call.id, true, result)
    } catch (error) {
      this.writeBrowserResult(call.id, false, undefined, errorMessage(error))
    }
  }

  private writeBrowserResult(
    browserRequestId: number,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    if (!this.alive || !this.proc.stdin || this.proc.stdin.destroyed) return
    try {
      this.proc.stdin.write(
        `${JSON.stringify({
          id: this.nextId++,
          op: 'browser-result',
          browserRequestId,
          ok,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error: error.slice(0, 8_192) } : {}),
        })}\n`,
      )
    } catch (writeError) {
      this.fail(new PackToolHostUnavailable(errorMessage(writeError)))
    }
  }

  private async handleSessionCall(
    sessionRequestId: number,
    invocationId: number,
    op: 'get' | 'set' | 'delete',
    state: unknown,
  ): Promise<void> {
    const invocation = this.pending.get(invocationId)
    if (!invocation?.threadId) {
      this.writeSessionResult(sessionRequestId, false, undefined, 'No active model thread.')
      return
    }
    try {
      let result: unknown = null
      if (op === 'get') {
        result = await this.sessionStore.get(this.packId, invocation.threadId)
      } else if (op === 'set') {
        await this.sessionStore.set(this.packId, invocation.threadId, state)
      } else {
        await this.sessionStore.delete(this.packId, invocation.threadId)
      }
      this.writeSessionResult(sessionRequestId, true, result)
    } catch (err) {
      this.writeSessionResult(sessionRequestId, false, undefined, errorMessage(err))
    }
  }

  private writeSessionResult(
    sessionRequestId: number,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    if (!this.alive || !this.proc.stdin || this.proc.stdin.destroyed) return
    try {
      this.proc.stdin.write(
        `${JSON.stringify({
          id: this.nextId++,
          op: 'session-result',
          sessionRequestId,
          ok,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error: error.slice(0, 8_192) } : {}),
        })}\n`,
      )
    } catch (err) {
      this.fail(new PackToolHostUnavailable(errorMessage(err)))
    }
  }

  private request(
    body: Record<string, unknown>,
    timeoutMs: number,
    options?: { signal?: AbortSignal; threadId?: string },
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
        ...(options?.signal ? { signal: options.signal, onAbort } : {}),
        ...(options?.threadId ? { threadId: options.threadId } : {}),
      })
      options?.signal?.addEventListener('abort', onAbort, { once: true })
      if (options?.signal?.aborted) {
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

  invokeTool(registrationId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      { op: 'invoke', kind: 'tool', registrationId, input },
      INVOCATION_TIMEOUT_MS,
      { ...(signal ? { signal } : {}) },
    )
  }

  invokeModel(registrationId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const turn = zPackModelTurn.parse(input)
    return this.request(
      { op: 'invoke', kind: 'model', registrationId, input: turn },
      INVOCATION_TIMEOUT_MS,
      { ...(signal ? { signal } : {}), threadId: turn.threadId },
    )
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
