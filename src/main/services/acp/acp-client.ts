import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type McpCapabilities,
  type McpServer,
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
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { StreamChunk } from '@shared/types'
import type { AcpAgentSandboxConfig, AcpModelChoice, AcpModelSelector } from '@shared/types/acp.ts'
import type { McpServerConfig } from '@shared/types/mcp.ts'
import { sessionUpdateToStreamChunk } from './session-update-adapter.ts'
import { envForRendererChildProcess } from '../child-process-env.ts'
import { acpAgentSandboxOverlay, ensureWorkspaceTmpDir } from '../../project-sandbox/config.ts'
import {
  formatArgvForShell,
  isProjectSandboxEnabled,
  shellForSandboxWrap,
} from '../../project-sandbox/spawn.ts'

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
  /**
   * Copse-configured MCP servers to hand the agent via `session/new`
   * (`mcpServers`), so the external agent can mount the user's servers itself.
   * Filtered against the agent's advertised `mcpCapabilities` before sending
   * (stdio is baseline; http needs the capability flag).
   */
  mcpServers?: McpServerConfig[]
  /**
   * Run the agent process under the workspace seatbelt with these relaxations
   * (issue #590). Only effective when the project sandbox is active on this
   * platform; otherwise the agent spawns unsandboxed as before.
   */
  sandbox?: AcpAgentSandboxConfig
  /**
   * Copse's native-tool MCP bridge for this turn (issue #602, tier 2). Added to
   * `session/new` `mcpServers` as an http server when the agent advertises
   * `mcpCapabilities.http`; ignored otherwise.
   */
  nativeBridge?: { url: string; token: string }
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
 * Spawn the external ACP agent, under the workspace seatbelt when the agent's
 * config opts in and the project sandbox is active (issue #590). The sandboxed
 * agent gets the same confines as native auto-run shell commands — workspace-
 * only writes, home denied except the agent's own {@link AcpAgentSandboxConfig}
 * dirs, network limited to its declared endpoints — and those confines apply to
 * its whole process tree, including its shell children.
 *
 * The env is always {@link buildAcpAgentEnv} (scrubbed of Copse's provider
 * keys). ASRT's `wrapWithSandboxArgv` returns `process.env` verbatim on POSIX,
 * so it must NOT be spawned with — that would resurrect the scrubbed secrets
 * inside the agent process. $TMPDIR is redirected to the workspace-owned
 * scratch dir the seatbelt allows (issue #481).
 */
async function spawnAcpAgentProcess(config: AcpAgentSpawnConfig): Promise<ChildProcess> {
  const env = buildAcpAgentEnv(config)
  const stdio: ('pipe' | 'inherit')[] = ['pipe', 'pipe', 'inherit']
  if (config.sandbox && process.platform !== 'win32' && isProjectSandboxEnabled()) {
    const overlay = acpAgentSandboxOverlay(config.cwd, config.sandbox, {
      allowLocalhost: Boolean(config.nativeBridge),
    })
    const command = formatArgvForShell(config.command, config.args ?? [])
    const { argv } = await SandboxManager.wrapWithSandboxArgv(
      command,
      shellForSandboxWrap(),
      overlay,
    )
    const file = argv[0]
    if (!file) throw new Error('sandbox wrap produced empty argv')
    const tmpDir = ensureWorkspaceTmpDir()
    return spawn(file, argv.slice(1), {
      cwd: config.cwd,
      env: { ...env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir },
      stdio,
    })
  }
  return spawn(config.command, config.args ?? [], { cwd: config.cwd, env, stdio })
}

/**
 * Convert Copse MCP server configs to the ACP `session/new` `mcpServers` shape,
 * keeping only what the agent said it supports in `initialize`: stdio is the
 * protocol baseline, http needs `mcpCapabilities.http`. Unsupported transports
 * are dropped rather than failing the session — the agent just doesn't get that
 * server this turn.
 */
export function toAcpMcpServers(
  configs: readonly McpServerConfig[],
  capabilities: McpCapabilities | undefined,
): McpServer[] {
  const servers: McpServer[] = []
  for (const cfg of configs) {
    if (cfg.transport === 'stdio' && cfg.command !== undefined) {
      servers.push({
        name: cfg.name,
        command: cfg.command,
        args: cfg.args ?? [],
        env: Object.entries(cfg.env ?? {}).map(([name, value]) => ({ name, value })),
      })
    } else if (cfg.transport === 'http' && cfg.url !== undefined && capabilities?.http === true) {
      servers.push({
        type: 'http',
        name: cfg.name,
        url: cfg.url,
        headers: Object.entries(cfg.headers ?? {}).map(([name, value]) => ({ name, value })),
      })
    }
  }
  return servers
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
  const child = await spawnAcpAgentProcess(config)
  if (!child.stdin || !child.stdout) throw new Error('ACP agent spawned without stdio pipes')

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
      const initResponse = await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: Boolean(handlers.readTextFile),
            writeTextFile: Boolean(handlers.writeTextFile),
          },
        },
      })

      const mcpCapabilities = initResponse.agentCapabilities?.mcpCapabilities
      const mcpServers = toAcpMcpServers(config.mcpServers ?? [], mcpCapabilities)
      // Copse's own tools ride the same channel as forwarded servers: an http
      // MCP endpoint the agent mounts itself (#602 tier 2). http-capable only —
      // agents without the capability simply don't get the bridge this turn.
      if (config.nativeBridge && mcpCapabilities?.http === true) {
        mcpServers.push({
          type: 'http',
          name: 'copse',
          url: config.nativeBridge.url,
          headers: [{ name: 'Authorization', value: `Bearer ${config.nativeBridge.token}` }],
        })
      }
      return ctx.buildSession({ cwd: config.cwd, mcpServers }).withSession(async (session) => {
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
  const child = await spawnAcpAgentProcess(config)
  if (!child.stdin || !child.stdout) throw new Error('ACP agent spawned without stdio pipes')
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
