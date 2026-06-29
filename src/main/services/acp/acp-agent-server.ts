import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type AgentConnection,
  type PromptRequest,
  type RequestPermissionOutcome,
  type StopReason,
} from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import type { StreamChunk } from '@shared/types'
import { streamChunkToSessionUpdate } from './session-update-adapter.ts'

/**
 * ACP **Agent role** for Copse: expose Copse's agent loop over the Agent Client
 * Protocol so an ACP client (any ACP-speaking editor or workspace) can add the
 * Copse agent to a session and drive it.
 *
 * The protocol plumbing here is deliberately decoupled from Electron and from
 * the concrete agent loop: callers supply an {@link AcpTurnRunner}, so the
 * server can be unit-tested in-process and the real Copse wiring lives in a
 * thin entry point (see `runAcpAgentMode` in `acp-app-entry.ts`, which drives
 * the full `runAgent`).
 */

export type AcpPermissionDecision = 'allow' | 'reject' | 'cancelled'

export interface AcpPermissionRequest {
  toolCallId: string
  title: string
  rawInput?: unknown
}

/** Context handed to the turn runner for a single `session/prompt`. */
export interface AcpTurnContext {
  sessionId: string
  /** The user's prompt, flattened to text from the ACP content blocks. */
  prompt: string
  /** Aborts when the client sends `session/cancel` for this session. */
  signal: AbortSignal
  /** Stream a Copse chunk back to the client as a `session/update`. */
  emit(chunk: StreamChunk): Promise<void>
  /** Ask the client to approve a tool call before it runs. */
  requestPermission(req: AcpPermissionRequest): Promise<AcpPermissionDecision>
}

export type AcpTurnRunner = (
  ctx: AcpTurnContext,
) => Promise<{ stopReason?: StopReason } | undefined>

export interface AcpAgentOptions {
  /** Advertised agent name in `initialize`. */
  name?: string
  /** Whether the agent supports `session/load`. Defaults to false. */
  loadSession?: boolean
}

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function promptToText(prompt: PromptRequest['prompt']): string {
  return prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

function decisionFromOutcome(outcome: RequestPermissionOutcome): AcpPermissionDecision {
  if (outcome.outcome === 'cancelled') return 'cancelled'
  return outcome.optionId === 'allow' ? 'allow' : 'reject'
}

/**
 * Build (but do not connect) the ACP agent app. Register the standard ACP
 * agent methods and route `session/prompt` through `runner`.
 */
export function buildAcpAgentApp(runner: AcpTurnRunner, options: AcpAgentOptions = {}): AgentApp {
  const pending = new Map<string, AbortController>()

  return agent({ name: options.name ?? 'copse' })
    .onRequest('initialize', () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: options.loadSession ?? false },
    }))
    .onRequest('authenticate', () => ({}))
    .onRequest('session/new', () => ({ sessionId: randomSessionId() }))
    .onRequest('session/prompt', async (ctx) => {
      const params = ctx.params
      const peer = ctx.client
      pending.get(params.sessionId)?.abort()
      const controller = new AbortController()
      pending.set(params.sessionId, controller)

      const turnCtx: AcpTurnContext = {
        sessionId: params.sessionId,
        prompt: promptToText(params.prompt),
        signal: controller.signal,
        emit: async (chunk) => {
          const update = streamChunkToSessionUpdate(chunk)
          if (update) {
            await peer.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update,
            })
          }
        },
        requestPermission: async (req) => {
          const res = await peer.request(methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: req.toolCallId,
              title: req.title,
              status: 'pending',
              rawInput: req.rawInput,
            },
            options: [
              { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
              { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
            ],
          })
          return decisionFromOutcome(res.outcome)
        },
      }

      try {
        const result = await runner(turnCtx)
        return { stopReason: result?.stopReason ?? 'end_turn' }
      } catch (err) {
        if (controller.signal.aborted) return { stopReason: 'cancelled' }
        throw err
      } finally {
        pending.delete(params.sessionId)
      }
    })
    .onNotification('session/cancel', (ctx) => {
      const params = ctx.params
      pending.get(params.sessionId)?.abort()
    })
}

/**
 * Serve the Copse ACP agent over stdio (ndjson framing). This is the headless
 * entry an ACP client spawns: `copse --acp`.
 */
export function serveAcpAgentOverStdio(
  runner: AcpTurnRunner,
  options?: AcpAgentOptions,
): AgentConnection {
  const writable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(writable, readable)
  return buildAcpAgentApp(runner, options).connect(stream)
}
