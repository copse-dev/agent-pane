import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk'
import { spawn, type ChildProcess } from 'node:child_process'
import { Writable } from 'node:stream'

export interface AcpLongRunProbeConfig {
  agentId: string
  title: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd: string
}

export type AcpLongRunProbeMode = 'stream' | 'blocking-fs-read'

export interface AcpLongRunProbeOptions {
  durationMs?: number
  progressIntervalMs?: number
  timeoutMs?: number
  prompt?: string
  mode?: AcpLongRunProbeMode
  createTransport?: (
    config: AcpLongRunProbeConfig,
  ) => Promise<{ stream: Stream; dispose: () => void }>
}

export interface AcpLongRunPermissionRecord {
  title: string | null
  kind: string
  optionIds: string[]
  optionKinds: string[]
  rawInputKeys: string[]
}

export interface AcpLongRunReport {
  agentId: string
  title: string
  command: string
  args: string[]
  prompt: string
  mode: AcpLongRunProbeMode
  ok: boolean
  error?: string
  stopReason?: string | null
  elapsedMs: number
  expectedDurationMs: number
  completedEarly: boolean
  firstUpdateAfterMs: number | null
  lastUpdateAfterMs: number | null
  maxSilentGapMs: number | null
  updateCount: number
  updateKinds: string[]
  textChunkCount: number
  toolCallCount: number
  fsReadRequestCount: number
  permissionRequests: AcpLongRunPermissionRecord[]
}

const DEFAULT_DURATION_MS = 6 * 60_000
const DEFAULT_PROGRESS_INTERVAL_MS = 30_000
const DEFAULT_TIMEOUT_GRACE_MS = 90_000
const STDERR_TAIL_LIMIT = 8_000
const ERROR_DETAIL_LIMIT = 2_000

export function defaultLongRunPrompt(durationMs: number, progressIntervalMs: number): string {
  const durationSeconds = Math.ceil(durationMs / 1000)
  const intervalSeconds = Math.ceil(progressIntervalMs / 1000)
  return [
    `Run a long-lived ACP liveness check for at least ${String(durationSeconds)} seconds.`,
    'Do not edit files, do not run shell commands, and do not call tools unless absolutely required.',
    `Every ${String(intervalSeconds)} seconds, send a short visible progress message exactly like LONG_RUN_TICK <number>.`,
    `After at least ${String(durationSeconds)} seconds have elapsed, send LONG_RUN_DONE and stop.`,
  ].join(' ')
}

export function defaultBlockingReadPrompt(durationMs: number): string {
  const durationSeconds = Math.ceil(durationMs / 1000)
  return [
    `Read the file named .copse-acp-long-run-block.txt in the workspace root and wait for its contents.`,
    `The client will intentionally take at least ${String(durationSeconds)} seconds to return that file.`,
    'Do not edit files and do not run shell commands.',
    'After the file content is returned, reply with LONG_RUN_DONE and stop.',
  ].join(' ')
}

function appendStderrTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString()
  return next.length <= STDERR_TAIL_LIMIT ? next : next.slice(-STDERR_TAIL_LIMIT)
}

function processExitError(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const reason = signal ? `signal ${signal}` : `code ${code === null ? 'unknown' : String(code)}`
  const detail = stderr.trim()
  return new Error(
    `ACP agent "${command}" exited with ${reason}${detail ? `. stderr: ${detail}` : ''}`,
  )
}

function processSpawnError(command: string, err: Error, stderr: string): Error {
  const detail = stderr.trim()
  return new Error(
    `ACP agent "${command}" failed to start: ${err.message}${detail ? `. stderr: ${detail}` : ''}`,
  )
}

function truncateErrorDetail(value: string): string {
  return value.length <= ERROR_DETAIL_LIMIT ? value : `${value.slice(0, ERROR_DETAIL_LIMIT)}...`
}

function errorDataDetail(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    const data = Reflect.get(err, 'data')
    if (typeof data === 'string') return truncateErrorDetail(data)
    if (typeof data === 'object' && data !== null && 'details' in data) {
      const details = Reflect.get(data, 'details')
      if (typeof details === 'string') return truncateErrorDetail(details)
    }
    try {
      const encoded = JSON.stringify(data)
      return typeof encoded === 'string' ? truncateErrorDetail(encoded) : null
    } catch {
      return null
    }
  }
  if (err instanceof Error && err.cause) return errorDataDetail(err.cause)
  return null
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const detail = errorDataDetail(err)
  if (!detail || message.includes(detail)) return message
  return `${message}: ${detail}`
}

function rawInputKeysOf(rawInput: unknown): string[] {
  if (rawInput === null || rawInput === undefined) return []
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) return []
  return Object.keys(rawInput)
}

function recordPermission(req: RequestPermissionRequest): AcpLongRunPermissionRecord {
  return {
    title: req.toolCall.title ?? null,
    kind: req.toolCall.kind ?? 'unknown',
    optionIds: req.options.map((option) => option.optionId),
    optionKinds: req.options.map((option) => option.kind),
    rawInputKeys: rawInputKeysOf(req.toolCall.rawInput),
  }
}

function captureChildStderr(child: ChildProcess, command: string): () => string {
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = appendStderrTail(tail, chunk)
    const text = chunk.toString().trimEnd()
    if (text) console.warn(`[acp-long:${command}] ${text}`)
  })
  return () => tail
}

function childStdoutStream(
  child: ChildProcess,
  command: string,
  stderrTail: () => string,
): { readable: ReadableStream<Uint8Array>; dispose: () => void } {
  const stdout = child.stdout
  if (!stdout) throw new Error('ACP agent spawned without stdout pipe')
  let cancelRead = (): void => {
    child.kill()
  }
  const readable = new ReadableStream<Uint8Array>({
    start(controller): void {
      let settled = false
      const cleanup = (): void => {
        stdout.off('data', onData)
        stdout.off('error', onStdoutError)
        child.off('error', onChildError)
        child.off('close', onChildClose)
      }
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }
      const onData = (chunk: Buffer): void => {
        controller.enqueue(new Uint8Array(chunk))
      }
      const onStdoutError = (err: Error): void => {
        settle(() => {
          controller.error(err)
        })
      }
      const onChildError = (err: Error): void => {
        settle(() => {
          controller.error(processSpawnError(command, err, stderrTail()))
        })
      }
      const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (code === 0 && signal === null) {
          settle(() => {
            controller.close()
          })
        } else {
          settle(() => {
            controller.error(processExitError(command, code, signal, stderrTail()))
          })
        }
      }
      cancelRead = (): void => {
        if (!settled) {
          settled = true
          cleanup()
        }
        child.kill()
      }
      stdout.on('data', onData)
      stdout.on('error', onStdoutError)
      child.once('error', onChildError)
      child.once('close', onChildClose)
    },
    cancel(): void {
      cancelRead()
    },
  })
  return {
    readable,
    dispose: (): void => {
      cancelRead()
    },
  }
}

function spawnLongRunTransport(
  config: AcpLongRunProbeConfig,
): Promise<{ stream: Stream; dispose: () => void }> {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderrTail = captureChildStderr(child, config.command)
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const { readable, dispose } = childStdoutStream(child, config.command, stderrTail)
  return Promise.resolve({
    stream: ndJsonStream(writable, readable),
    dispose: (): void => {
      dispose()
    },
  })
}

const PROMPT_SUCCESS_IGNORED = new Promise<never>(() => {
  // Successful completion is observed as a stop message in the update stream.
})

function promptRejectionOnly<T>(promise: Promise<T>): Promise<never> {
  return promise.then(
    () => PROMPT_SUCCESS_IGNORED,
    (err: unknown) => Promise.reject(err instanceof Error ? err : new Error(String(err))),
  )
}

function isTextChunk(update: SessionUpdate): boolean {
  return (
    update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk'
  )
}

function isToolCall(update: SessionUpdate): boolean {
  return update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function probeAgentLongRun(
  config: AcpLongRunProbeConfig,
  options: AcpLongRunProbeOptions = {},
): Promise<AcpLongRunReport> {
  const expectedDurationMs = options.durationMs ?? DEFAULT_DURATION_MS
  const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? expectedDurationMs + DEFAULT_TIMEOUT_GRACE_MS
  const mode = options.mode ?? 'stream'
  const prompt =
    options.prompt ??
    (mode === 'blocking-fs-read'
      ? defaultBlockingReadPrompt(expectedDurationMs)
      : defaultLongRunPrompt(expectedDurationMs, progressIntervalMs))
  const createTransport = options.createTransport ?? spawnLongRunTransport

  const base = {
    agentId: config.agentId,
    title: config.title,
    command: config.command,
    args: config.args ?? [],
    prompt,
    mode,
    expectedDurationMs,
  }

  const startedAt = Date.now()
  const updateTimes: number[] = []
  const updateKinds: string[] = []
  const permissionRequests: AcpLongRunPermissionRecord[] = []
  let textChunkCount = 0
  let toolCallCount = 0
  let fsReadRequestCount = 0
  let transport: { stream: Stream; dispose: () => void } | null = null
  const state = { timedOut: false }
  const timer = setTimeout(() => {
    state.timedOut = true
    transport?.dispose()
  }, timeoutMs)

  const finish = (partial: Partial<AcpLongRunReport>): AcpLongRunReport => {
    const elapsedMs = Date.now() - startedAt
    const completedEarly = elapsedMs < expectedDurationMs
    const firstUpdateAfterMs = updateTimes[0] ?? null
    const lastUpdateAfterMs = updateTimes.at(-1) ?? null
    const gaps = updateTimes.map(
      (time, index) => time - (index === 0 ? 0 : (updateTimes[index - 1] ?? 0)),
    )
    const report: AcpLongRunReport = {
      ...base,
      ok: false,
      elapsedMs,
      completedEarly,
      firstUpdateAfterMs,
      lastUpdateAfterMs,
      maxSilentGapMs: gaps.length > 0 ? Math.max(...gaps) : null,
      updateCount: updateTimes.length,
      updateKinds: [...new Set(updateKinds)],
      textChunkCount,
      toolCallCount,
      fsReadRequestCount,
      permissionRequests,
      ...partial,
    }
    if (report.ok && mode === 'blocking-fs-read' && fsReadRequestCount === 0) {
      return {
        ...report,
        ok: false,
        error: 'completed without exercising the blocking fs/read_text_file request',
      }
    }
    if (report.ok && completedEarly) {
      return {
        ...report,
        ok: false,
        error: `completed before expected duration (${String(elapsedMs)}ms < ${String(expectedDurationMs)}ms)`,
      }
    }
    return report
  }

  try {
    transport = await createTransport(config)
    const app = client({ name: 'copse-long-run-probe' })
      .onRequest(methods.client.fs.readTextFile, async () => {
        fsReadRequestCount += 1
        if (mode !== 'blocking-fs-read') throw new Error('fs/read disabled')
        await sleepMs(expectedDurationMs)
        return { content: 'LONG_RUN_BLOCK_OK' }
      })
      .onRequest(methods.client.fs.writeTextFile, () =>
        Promise.reject(new Error('fs/write disabled')),
      )
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        permissionRequests.push(recordPermission(ctx.params))
        const reject = ctx.params.options.find((option) => option.kind === 'reject_once')
        const optionId = reject?.optionId ?? ctx.params.options.at(-1)?.optionId
        if (!optionId) return { outcome: { outcome: 'cancelled' as const } }
        return { outcome: { outcome: 'selected' as const, optionId } }
      })

    const stopReason = await app.connectWith(transport.stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: mode === 'blocking-fs-read', writeTextFile: false },
        },
      })
      return ctx.buildSession(config.cwd).withSession(async (session) => {
        const promptFailure = promptRejectionOnly(session.prompt(prompt))
        for (;;) {
          const message = await Promise.race([session.nextUpdate(), promptFailure])
          if (message.kind === 'stop') return message.response.stopReason
          const elapsed = Date.now() - startedAt
          updateTimes.push(elapsed)
          updateKinds.push(message.update.sessionUpdate)
          if (isTextChunk(message.update)) textChunkCount += 1
          if (isToolCall(message.update)) toolCallCount += 1
        }
      })
    })

    return finish({ ok: true, stopReason })
  } catch (err) {
    return finish({
      ok: false,
      error: state.timedOut ? `timed out after ${String(timeoutMs)}ms` : errorMessage(err),
    })
  } finally {
    clearTimeout(timer)
    transport?.dispose()
  }
}
