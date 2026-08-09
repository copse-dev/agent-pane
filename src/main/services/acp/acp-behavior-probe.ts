import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type SessionUpdate,
  type Stream,
  type ToolKind,
  type WriteTextFileRequest,
} from '@agentclientprotocol/sdk'
import { spawn, type ChildProcess } from 'node:child_process'
import { Writable } from 'node:stream'
import { isRecord } from '@shared/unknown-value.ts'
import { tapAcpWireStream } from './acp-wire-tap.ts'

/**
 * Tier-2 ACP **behavioural probe** (issue #832): spawn an external ACP agent,
 * send one real `session/prompt`, and record what happens under a live turn —
 * write routing (`fs/write_text_file` vs shell/`execute` tool calls),
 * `session/request_permission` payloads, and mid-turn `_meta` keys.
 *
 * Tier 1 (`acp-capability-probe.ts`) only negotiates capabilities and never
 * prompts. Tier 2 spends model tokens (against real agents) and needs auth, so
 * it is opt-in (`npm run probe:acp:behavior`). Unit tests drive an in-memory
 * fake agent so the extraction stays deterministic in CI.
 */

/** How an agent applied a file write during the probed turn. */
export type AcpWriteRouting = 'fs_write_text_file' | 'shell_or_execute' | 'both' | 'none'

/** Sanitized view of one `session/request_permission` the agent raised. */
export interface AcpPermissionProbeRecord {
  toolCallId: string
  title: string | null
  /** Programmatic tool name on the permission's tool call, if the agent sent one. */
  name: string | null
  kind: ToolKind | 'unknown'
  optionIds: string[]
  optionKinds: string[]
  /** Flattened `_meta` keys on the permission request and its toolCall. */
  metaKeys: string[]
  /** Coarse shape of `rawInput` (keys only — never values; may contain secrets). */
  rawInputKeys: string[]
}

/** One file write observed via the client's `fs/write_text_file` handler. */
export interface AcpFsWriteProbeRecord {
  path: string
  /** Byte length of the content the agent asked to write. */
  contentBytes: number
  metaKeys: string[]
}

/** One tool_call / tool_call_update observed during the turn. */
export interface AcpToolCallProbeRecord {
  toolCallId: string
  title: string | null
  /**
   * The programmatic tool name ACP models alongside `title`. Recorded because
   * `title` is what Copse renders, and an adapter that sends only a generic
   * `MCP: tool` title may still be sending a usable `name` here.
   */
  name: string | null
  kind: ToolKind | 'unknown'
  status: string | null
  metaKeys: string[]
}

/**
 * Structured observations from a single prompted turn. Purely derived from
 * protocol events — no model-output interpretation beyond the write/tool
 * channels the ACP client already exposes.
 */
export interface AcpBehaviorSnapshot {
  /** How writes reached the client (if at all). */
  writeRouting: AcpWriteRouting
  fsWrites: AcpFsWriteProbeRecord[]
  permissionRequests: AcpPermissionProbeRecord[]
  toolCalls: AcpToolCallProbeRecord[]
  /** Distinct `sessionUpdate` kinds seen while the prompt was in flight. */
  updateKinds: string[]
  /** Flattened `_meta` keys harvested mid-turn (permissions, updates, writes). */
  midTurnMetaKeys: string[]
  /**
   * Top-level field names seen on tool-bearing payloads **on the wire**, before
   * the SDK's `z.object` parse drops everything ACP does not model. Keys only,
   * never values — this is the matrix's answer to "does this adapter send
   * anything we are throwing away?". Compare against the modelled fields on
   * {@link AcpToolCallProbeRecord}; the unredacted values live in the opt-in
   * wire trace (`acp-wire-trace.ts`) instead.
   */
  wireToolCallKeys: string[]
  stopReason: string | null
}

export interface AcpBehaviorReport {
  agentId: string
  title: string
  command: string
  args: string[]
  probedAt?: string
  /** Prompt text that was sent (fixed for real-agent runs). */
  prompt: string
  ok: boolean
  error?: string
  snapshot?: AcpBehaviorSnapshot
}

export interface AcpBehaviorProbeConfig {
  agentId: string
  title: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Absolute workspace root passed as the ACP session `cwd`. */
  cwd: string
}

export interface AcpBehaviorProbeOptions {
  /**
   * Prompt to send. Real-agent runs use a fixed write-a-marker-file instruction;
   * tests inject whatever drives the fake agent.
   */
  prompt?: string
  /** Overall timeout before the agent is killed. Default 120s (model turns are slow). */
  timeoutMs?: number
  /** Transport injection so tests can wire an in-process agent. */
  createTransport?: (
    config: AcpBehaviorProbeConfig,
  ) => Promise<{ stream: Stream; dispose: () => void }>
}

/** Default prompt used against real agents — asks for a write without dictating the API. */
export const DEFAULT_BEHAVIOR_PROMPT =
  'Create a new file named .copse-acp-behavior-probe.txt in the workspace root ' +
  'containing exactly the text PROBE_OK (and nothing else). Prefer the ACP ' +
  'filesystem write API when available. Then stop — do not run further tools.'

function metaKeysOf(meta: Record<string, unknown> | null | undefined): string[] {
  return meta ? Object.keys(meta) : []
}

function normalizeMeta(
  meta: { [k: string]: unknown } | null | undefined,
): Record<string, unknown> | null {
  return meta ?? null
}

function rawInputKeysOf(rawInput: unknown): string[] {
  if (rawInput === null || rawInput === undefined) return []
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) return []
  return Object.keys(rawInput)
}

function classifyWriteRouting(
  fsWrites: readonly AcpFsWriteProbeRecord[],
  toolCalls: readonly AcpToolCallProbeRecord[],
): AcpWriteRouting {
  const viaFs = fsWrites.length > 0
  const viaShell = toolCalls.some((call) => call.kind === 'execute')
  if (viaFs && viaShell) return 'both'
  if (viaFs) return 'fs_write_text_file'
  if (viaShell) return 'shell_or_execute'
  return 'none'
}

/**
 * Derive the comparable {@link AcpBehaviorSnapshot} from recorded turn events.
 * Pure and side-effect-free — unit-tested independently of the transport.
 */
export function extractBehaviorSnapshot(input: {
  fsWrites: readonly AcpFsWriteProbeRecord[]
  permissionRequests: readonly AcpPermissionProbeRecord[]
  toolCalls: readonly AcpToolCallProbeRecord[]
  updateKinds: readonly string[]
  midTurnMetaKeys: readonly string[]
  /** Optional: callers without a wire tap (older tests) report no keys. */
  wireToolCallKeys?: readonly string[] | undefined
  stopReason: string | null
}): AcpBehaviorSnapshot {
  const midTurnMetaKeys = [...new Set(input.midTurnMetaKeys)].sort()
  const updateKinds = [...new Set(input.updateKinds)]
  const wireToolCallKeys = [...new Set(input.wireToolCallKeys ?? [])].sort()
  return {
    writeRouting: classifyWriteRouting(input.fsWrites, input.toolCalls),
    fsWrites: [...input.fsWrites],
    permissionRequests: [...input.permissionRequests],
    toolCalls: [...input.toolCalls],
    updateKinds,
    midTurnMetaKeys,
    wireToolCallKeys,
    stopReason: input.stopReason,
  }
}

/**
 * Pull the top-level field names off any tool-bearing payload in one inbound
 * JSON-RPC message, tagged by where they sat. Shape-driven and schema-free, so
 * a vendor field survives to be counted; values are never read.
 */
export function wireToolCallKeysOf(message: unknown): string[] {
  if (!isRecord(message)) return []
  const params = message['params']
  if (!isRecord(params)) return []

  const update = params['update']
  if (isRecord(update)) {
    const kind = update['sessionUpdate']
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return []
    return Object.keys(update).map((key) => `${kind}:${key}`)
  }

  const toolCall = params['toolCall']
  if (isRecord(toolCall)) {
    return [
      ...Object.keys(params).map((key) => `request_permission:${key}`),
      ...Object.keys(toolCall).map((key) => `request_permission.toolCall:${key}`),
    ]
  }
  return []
}

function recordPermission(req: RequestPermissionRequest): AcpPermissionProbeRecord {
  const reqMeta = normalizeMeta(req._meta)
  const toolMeta = normalizeMeta(req.toolCall._meta)
  return {
    toolCallId: req.toolCall.toolCallId,
    title: req.toolCall.title ?? null,
    name: req.toolCall.name ?? null,
    kind: req.toolCall.kind ?? 'unknown',
    optionIds: req.options.map((option) => option.optionId),
    optionKinds: req.options.map((option) => option.kind),
    metaKeys: [
      ...metaKeysOf(reqMeta).map((key) => `permission:${key}`),
      ...metaKeysOf(toolMeta).map((key) => `permission.toolCall:${key}`),
    ],
    rawInputKeys: rawInputKeysOf(req.toolCall.rawInput),
  }
}

function recordFsWrite(req: WriteTextFileRequest): AcpFsWriteProbeRecord {
  return {
    path: req.path,
    contentBytes: Buffer.byteLength(req.content, 'utf8'),
    metaKeys: metaKeysOf(normalizeMeta(req._meta)).map((key) => `fs/write_text_file:${key}`),
  }
}

function recordToolFromUpdate(update: SessionUpdate): AcpToolCallProbeRecord | null {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return null
  }
  const toolMeta = normalizeMeta(update._meta)
  return {
    toolCallId: update.toolCallId,
    title: update.title ?? null,
    name: update.name ?? null,
    kind: update.kind ?? 'unknown',
    status: update.status ?? null,
    metaKeys: metaKeysOf(toolMeta).map((key) => `${update.sessionUpdate}:${key}`),
  }
}

/** Harvest `_meta` keys from non-tool session updates (message chunks, etc.). */
function sessionUpdateMetaKeys(update: SessionUpdate): string[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return metaKeysOf(normalizeMeta(update._meta)).map(
        (key) => `update:${update.sessionUpdate}:${key}`,
      )
    default:
      return []
  }
}

const UNSUPPORTED = (method: string) => (): Promise<never> =>
  Promise.reject(new Error(`Client capability not enabled during behavior probe: ${method}`))

const ACP_PROBE_STDERR_TAIL_LIMIT = 8_000

function appendProbeStderrTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString()
  return next.length <= ACP_PROBE_STDERR_TAIL_LIMIT
    ? next
    : next.slice(-ACP_PROBE_STDERR_TAIL_LIMIT)
}

function acpProbeProcessExitError(
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

function acpProbeProcessSpawnError(command: string, err: Error, stderr: string): Error {
  const detail = stderr.trim()
  return new Error(
    `ACP agent "${command}" failed to start: ${err.message}${detail ? `. stderr: ${detail}` : ''}`,
  )
}

const ACP_PROBE_ERROR_DETAIL_LIMIT = 2_000

function truncateProbeErrorDetail(value: string): string {
  return value.length <= ACP_PROBE_ERROR_DETAIL_LIMIT
    ? value
    : `${value.slice(0, ACP_PROBE_ERROR_DETAIL_LIMIT)}...`
}

function acpProbeErrorDataDetail(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    const data = Reflect.get(err, 'data')
    if (typeof data === 'string') return truncateProbeErrorDetail(data)
    if (typeof data === 'object' && data !== null && 'details' in data) {
      const details = Reflect.get(data, 'details')
      if (typeof details === 'string') return truncateProbeErrorDetail(details)
    }
    try {
      const encoded = JSON.stringify(data)
      return typeof encoded === 'string' ? truncateProbeErrorDetail(encoded) : null
    } catch {
      return null
    }
  }
  if (err instanceof Error && err.cause) return acpProbeErrorDataDetail(err.cause)
  return null
}

function acpProbeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const detail = acpProbeErrorDataDetail(err)
  if (!detail || message.includes(detail)) return message
  return `${message}: ${detail}`
}

const PROMPT_SUCCESS_IGNORED = new Promise<never>(() => {
  // The behavior probe drains successful turn completion from session.nextUpdate().
})

function promptRejectionOnly<T>(promise: Promise<T>): Promise<never> {
  return promise.then(
    () => PROMPT_SUCCESS_IGNORED,
    (err: unknown) => Promise.reject(err instanceof Error ? err : new Error(String(err))),
  )
}

function captureProbeChildStderr(child: ChildProcess, command: string): () => string {
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = appendProbeStderrTail(tail, chunk)
    const text = chunk.toString().trimEnd()
    if (text) console.warn(`[acp-behavior:${command}] ${text}`)
  })
  return () => tail
}

function probeChildStdoutStream(
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
          controller.error(acpProbeProcessSpawnError(command, err, stderrTail()))
        })
      }
      const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (code === 0 && signal === null) {
          settle(() => {
            controller.close()
          })
        } else {
          settle(() => {
            controller.error(acpProbeProcessExitError(command, code, signal, stderrTail()))
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

/** Default transport: spawn the agent process and frame stdio as ndjson. */
function spawnProbeTransport(
  config: AcpBehaviorProbeConfig,
): Promise<{ stream: Stream; dispose: () => void }> {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderrTail = captureProbeChildStderr(child, config.command)
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const { readable, dispose } = probeChildStdoutStream(child, config.command, stderrTail)
  return Promise.resolve({
    stream: ndJsonStream(writable, readable),
    dispose: (): void => {
      dispose()
    },
  })
}

/**
 * Probe one agent under a real prompt turn. Never throws — spawn/handshake/
 * turn failures are captured as `{ ok: false, error }` so a multi-agent matrix
 * run keeps going.
 */
export async function probeAgentBehavior(
  config: AcpBehaviorProbeConfig,
  options: AcpBehaviorProbeOptions = {},
): Promise<AcpBehaviorReport> {
  const prompt = options.prompt ?? DEFAULT_BEHAVIOR_PROMPT
  const timeoutMs = options.timeoutMs ?? 120_000
  const createTransport = options.createTransport ?? spawnProbeTransport

  const base = {
    agentId: config.agentId,
    title: config.title,
    command: config.command,
    args: config.args ?? [],
    prompt,
  }

  const fsWrites: AcpFsWriteProbeRecord[] = []
  const permissionRequests: AcpPermissionProbeRecord[] = []
  const toolCalls: AcpToolCallProbeRecord[] = []
  const updateKinds: string[] = []
  const midTurnMetaKeys: string[] = []
  const wireToolCallKeys: string[] = []

  let transport: { stream: Stream; dispose: () => void } | null = null
  const state = { timedOut: false }
  const timer = setTimeout(() => {
    state.timedOut = true
    transport?.dispose()
  }, timeoutMs)

  try {
    transport = await createTransport(config)
    // Count wire-level field names before the SDK parse strips unmodelled ones.
    // Unlike the file-backed trace this is always on, because it keeps only
    // key names — there is nothing sensitive to gate behind a flag.
    const stream = tapAcpWireStream(transport.stream, {
      record: (message) => wireToolCallKeys.push(...wireToolCallKeysOf(message)),
    })
    const app = client({ name: 'copse-behavior-probe' })
      .onRequest(methods.client.fs.readTextFile, UNSUPPORTED('fs/read_text_file'))
      .onRequest(methods.client.fs.writeTextFile, (ctx) => {
        const recorded = recordFsWrite(ctx.params)
        fsWrites.push(recorded)
        midTurnMetaKeys.push(...recorded.metaKeys)
        // Acknowledge without touching disk — the probe only measures routing.
        return {}
      })
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        const recorded = recordPermission(ctx.params)
        permissionRequests.push(recorded)
        midTurnMetaKeys.push(...recorded.metaKeys)
        const allow = ctx.params.options.find((option) => option.kind === 'allow_once')
        const optionId = allow?.optionId ?? ctx.params.options[0]?.optionId
        if (!optionId) {
          return { outcome: { outcome: 'cancelled' as const } }
        }
        return { outcome: { outcome: 'selected' as const, optionId } }
      })

    const snapshot = await app.connectWith(stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: true } },
      })
      return ctx.buildSession(config.cwd).withSession(async (session) => {
        // Fire the prompt; drain updates until the turn's stop message arrives.
        const promptFailure = promptRejectionOnly(session.prompt(prompt))
        for (;;) {
          const message = await Promise.race([session.nextUpdate(), promptFailure])
          if (message.kind === 'stop') {
            void ctx.notify('session/cancel', { sessionId: session.sessionId })
            return extractBehaviorSnapshot({
              fsWrites,
              permissionRequests,
              toolCalls,
              updateKinds,
              midTurnMetaKeys,
              wireToolCallKeys,
              stopReason: message.response.stopReason,
            })
          }
          const update = message.update
          if (!updateKinds.includes(update.sessionUpdate)) {
            updateKinds.push(update.sessionUpdate)
          }
          const tool = recordToolFromUpdate(update)
          if (tool) {
            toolCalls.push(tool)
            midTurnMetaKeys.push(...tool.metaKeys)
          } else {
            midTurnMetaKeys.push(...sessionUpdateMetaKeys(update))
          }
        }
      })
    })

    return { ...base, ok: true, snapshot }
  } catch (err) {
    const reason = state.timedOut
      ? `timed out after ${String(timeoutMs)}ms`
      : acpProbeErrorMessage(err)
    return { ...base, ok: false, error: reason }
  } finally {
    clearTimeout(timer)
    transport?.dispose()
  }
}
