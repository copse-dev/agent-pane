import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type StopReason,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import type { StreamChunk } from '@shared/types'
import { sessionUpdateToStreamChunk } from './session-update-adapter.ts'
import { envForRendererChildProcess } from '../child-process-env.ts'

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
}

const UNSUPPORTED = (method: string) => () =>
  Promise.reject(new Error(`Client capability not enabled: ${method}`))

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
): Promise<{ stopReason: StopReason }> {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: buildAcpAgentEnv(config),
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(writable, readable)

  const app = client({ name: 'copse' })
    .onRequest(methods.client.session.requestPermission, (ctx) =>
      handlers.requestPermission(ctx.params),
    )
    .onRequest(
      methods.client.fs.readTextFile,
      handlers.readTextFile
        ? (ctx) => handlers.readTextFile!(ctx.params)
        : UNSUPPORTED('fs/read_text_file'),
    )
    .onRequest(
      methods.client.fs.writeTextFile,
      handlers.writeTextFile
        ? (ctx) => handlers.writeTextFile!(ctx.params)
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
        const cancel = () => void ctx.notify('session/cancel', { sessionId: session.sessionId })
        if (signal) {
          if (signal.aborted) cancel()
          else signal.addEventListener('abort', cancel, { once: true })
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
