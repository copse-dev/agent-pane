import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type NewSessionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type StopReason,
  type Usage,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import type { StreamChunk } from '@shared/types'
import type { AcpModelChoice, AcpModelSelector } from '@shared/types/acp.ts'
import { sessionUpdateToStreamChunk } from './session-update-adapter.ts'
import { envForRendererChildProcess } from '../child-process-env.ts'

export type { AcpModelChoice, AcpModelSelector }

/**
 * ACP **Client role** for Copse: spawn and drive an external ACP agent
 * (Gemini CLI, Copilot CLI, Codex, …) and surface its activity through the same
 * `StreamChunk` pipeline the built-in agent loop already uses, so the renderer
 * needs no changes.
 *
 * The fs/permission callbacks let Copse keep ownership of the workspace and the
 * approval UX even though the external agent runs the model loop.
 */

export interface AcpClientHandlers {
  /** Forward a translated update to the UI (`agent:chunk`). */
  onChunk: (chunk: StreamChunk) => void
  /** Approve/deny a tool call the external agent wants to run. */
  requestPermission: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  /** Back `fs/read_text_file` with Copse's workspace-scoped reader. */
  readTextFile?: (req: ReadTextFileRequest) => Promise<ReadTextFileResponse>
  /** Back `fs/write_text_file` (e.g. route through the diff queue). */
  writeTextFile?: (req: WriteTextFileRequest) => Promise<WriteTextFileResponse>
}

export interface AcpAgentSpawnConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Absolute workspace root passed as the ACP session `cwd`. */
  cwd: string
  /**
   * Selected model as the `SessionConfigValueId` of the agent's `category:
   * "model"` config option. Applied via `session/set_config_option` before the
   * first prompt. Ignored when the agent exposes no model selector or the value
   * is already current.
   */
  model?: string
}

const UNSUPPORTED = (method: string) => (): Promise<never> =>
  Promise.reject(new Error(`Client capability not enabled: ${method}`))

/**
 * Find the agent's model selector in a `session/new` response, if any. ACP
 * surfaces model choice as a `SessionConfigOption` with `category: "model"` and
 * `type: "select"`; its `options` may be a flat list or grouped, so we flatten.
 * Returns `null` when the agent exposes no such option (model is then fixed to
 * the agent's own default).
 */
export function modelSelectorFrom(response: NewSessionResponse): AcpModelSelector | null {
  const option = (response.configOptions ?? []).find(
    (candidate): candidate is SessionConfigOption =>
      candidate.category === 'model' && candidate.type === 'select',
  )
  if (!option || option.type !== 'select') return null
  const choices: AcpModelChoice[] = []
  for (const entry of option.options) {
    if ('group' in entry) {
      for (const sub of entry.options) choices.push({ value: sub.value, label: sub.name })
    } else {
      choices.push({ value: entry.value, label: entry.name })
    }
  }
  return { configId: option.id, currentValue: option.currentValue, choices }
}

/**
 * Build the env for the spawned ACP agent. The base is scrubbed of LLM/provider
 * secrets via {@link envForRendererChildProcess} (an external agent runs its own
 * model loop and must not inherit Copse's cloud API keys); `config.env` is the
 * explicit allowlist of vars that agent is meant to receive and is overlaid last.
 */
export function buildAcpAgentEnv(config: AcpAgentSpawnConfig): Record<string, string> {
  return { ...envForRendererChildProcess(), ...(config.env ?? {}) }
}

/**
 * Run a single prompt turn against an external ACP agent. Spawns the agent,
 * initializes the connection, creates a session, sends the prompt, and pumps
 * `session/update` notifications to `handlers.onChunk` until the turn stops.
 * The subprocess is always terminated when the turn settles.
 */
export async function runAcpAgentPrompt(
  config: AcpAgentSpawnConfig,
  prompt: string,
  handlers: AcpClientHandlers,
  signal?: AbortSignal,
): Promise<{ stopReason: StopReason; usage?: Usage | null }> {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: buildAcpAgentEnv(config),
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(writable, readable)

  const readTextFile = handlers.readTextFile
  const writeTextFile = handlers.writeTextFile
  const app = client({ name: 'copse' })
    .onRequest(methods.client.session.requestPermission, (ctx) =>
      handlers.requestPermission(ctx.params),
    )
    .onRequest(
      methods.client.fs.readTextFile,
      readTextFile
        ? (ctx): Promise<ReadTextFileResponse> => readTextFile(ctx.params)
        : UNSUPPORTED('fs/read_text_file'),
    )
    .onRequest(
      methods.client.fs.writeTextFile,
      writeTextFile
        ? (ctx): Promise<WriteTextFileResponse> => writeTextFile(ctx.params)
        : UNSUPPORTED('fs/write_text_file'),
    )

  try {
    return await app.connectWith(stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: Boolean(handlers.readTextFile),
            writeTextFile: Boolean(handlers.writeTextFile),
          },
        },
      })

      return ctx.buildSession(config.cwd).withSession(async (session) => {
        const cancel = (): void =>
          void ctx.notify('session/cancel', { sessionId: session.sessionId })
        if (signal) {
          if (signal.aborted) cancel()
          else signal.addEventListener('abort', cancel, { once: true })
        }
        if (config.model) {
          const selector = modelSelectorFrom(session.newSessionResponse)
          // Only switch when the value is a model the agent still offers and it
          // isn't already current. A stale/removed value (e.g. after an agent
          // version bump) is skipped, and a rejected set is swallowed, so a bad
          // model selection degrades to the agent's default instead of failing
          // the whole turn.
          const isKnown = selector?.choices.some((choice) => choice.value === config.model) ?? false
          if (selector && isKnown && config.model !== selector.currentValue) {
            try {
              await ctx.request(methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: selector.configId,
                value: config.model,
              })
            } catch {
              // Fall back to the agent's default model for this turn.
            }
          }
        }
        void session.prompt(prompt)
        for (;;) {
          const message = await session.nextUpdate()
          if (message.kind === 'stop') return message.response
          const chunk = sessionUpdateToStreamChunk(message.update)
          if (chunk) handlers.onChunk(chunk)
        }
      })
    })
  } finally {
    child.kill()
  }
}

/**
 * Discover the models an external ACP agent offers, for the settings picker.
 * Spawns the agent, initializes, opens a throwaway session, reads its
 * `category: "model"` config option, and tears the process down. Returns `null`
 * when the agent exposes no model selector (its model is fixed to its default).
 *
 * This is a probe, not a turn: no prompt is sent, so it does not consume model
 * tokens — but it does start the agent process (and may trigger its auth), so
 * call it on demand (a "Detect models" action), not on every picker open.
 */
export async function listAcpAgentModels(
  config: AcpAgentSpawnConfig,
  timeoutMs = 15000,
): Promise<AcpModelSelector | null> {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: buildAcpAgentEnv(config),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(writable, readable)
  const app = client({ name: 'copse' })
    .onRequest(methods.client.fs.readTextFile, UNSUPPORTED('fs/read_text_file'))
    .onRequest(methods.client.fs.writeTextFile, UNSUPPORTED('fs/write_text_file'))

  const timer = setTimeout(() => child.kill(), timeoutMs)
  try {
    return await app.connectWith(stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      return ctx.buildSession(config.cwd).withSession((session) => {
        const selector = modelSelectorFrom(session.newSessionResponse)
        void ctx.notify('session/cancel', { sessionId: session.sessionId })
        return selector
      })
    })
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}
