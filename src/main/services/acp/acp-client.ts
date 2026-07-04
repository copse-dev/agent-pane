import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ClientConnection,
  type McpCapabilities,
  type McpServer,
  type NewSessionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type StopReason,
  type Stream,
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
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { acpAgentSandboxOverlay, ensureWorkspaceTmpDir } from '../../project-sandbox/config.ts'
import { acquireSandboxNetworkScope } from '../../project-sandbox/network-scope.ts'
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
/**
 * Whether an agent with this sandbox config will actually spawn confined:
 * needs the config, a POSIX platform, and the project sandbox to be active.
 * Exposed so callers (e.g. the prompt builder's sandbox note) stay in sync
 * with the spawn decision.
 */
export function willSandboxAcpAgent(sandbox: AcpAgentSandboxConfig | undefined): boolean {
  return Boolean(sandbox) && process.platform !== 'win32' && isProjectSandboxEnabled()
}

async function spawnAcpAgentProcess(config: AcpAgentSpawnConfig): Promise<ChildProcess> {
  const env = buildAcpAgentEnv(config)
  const stdio: ('pipe' | 'inherit')[] = ['pipe', 'pipe', 'inherit']
  if (config.sandbox && willSandboxAcpAgent(config.sandbox)) {
    const overlay = acpAgentSandboxOverlay(config.cwd, config.sandbox, {
      allowLocalhost: Boolean(config.nativeBridge),
    })
    // ASRT's proxies consult the GLOBAL config per connection — the overlay's
    // network block only wires restriction up. Widen the global allowlist for
    // exactly this process's lifetime (see network-scope.ts for the trade-off),
    // acquiring before spawn so the agent's first connection never races it.
    const release = acquireSandboxNetworkScope({
      domains: overlay.network?.allowedDomains ?? [],
      allowLocalBinding: overlay.network?.allowLocalBinding ?? false,
    })
    try {
      const command = formatArgvForShell(config.command, config.args ?? [])
      const { argv } = await SandboxManager.wrapWithSandboxArgv(
        command,
        shellForSandboxWrap(),
        overlay,
      )
      const file = argv[0]
      if (!file) throw new Error('sandbox wrap produced empty argv')
      const tmpDir = ensureWorkspaceTmpDir()
      const child = spawn(file, argv.slice(1), {
        cwd: config.cwd,
        env: { ...env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir },
        stdio,
      })
      child.once('close', release)
      child.once('error', release)
      return child
    } catch (err) {
      release()
      throw err
    }
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
 * Mutable per-turn handler slot for a persistent session (issue #605). The
 * connection-time JSON-RPC handlers are registered once for the session's
 * lifetime and delegate to whatever handlers the CURRENT (or, between turns,
 * the most recent) turn installed — so a background helper inside the agent
 * that writes via `fs/write_text_file` after its turn ended still lands in
 * the diff queue, and its updates still reach the last chunk sink.
 */
export interface MutableAcpHandlers {
  current: AcpClientHandlers | null
}

/**
 * A live, reusable connection + session to an external ACP agent. Created by
 * {@link openAcpSession}; drive turns with {@link runAcpSessionPrompt}; the
 * owner (the session pool) calls `dispose` on eviction.
 */
export interface OpenAcpSession {
  session: ActiveSession
  connection: ClientConnection
  handlers: MutableAcpHandlers
  mcpCapabilities: McpCapabilities | undefined
  /** Last model applied via `session/set_config_option` (avoid re-sending). */
  appliedModel: string | undefined
  /** True once the connection closed or the agent process died. */
  isClosed: () => boolean
  dispose: () => void
}

/** Transport injection point so tests can wire an in-process agent. */
export type AcpTransportFactory = (
  config: AcpAgentSpawnConfig,
) => Promise<{ stream: Stream; dispose: () => void }>

async function spawnTransport(
  config: AcpAgentSpawnConfig,
): Promise<{ stream: Stream; dispose: () => void }> {
  const child = await spawnAcpAgentProcess(config)
  if (!child.stdin || !child.stdout) throw new Error('ACP agent spawned without stdio pipes')
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  return {
    stream: ndJsonStream(writable, readable),
    dispose: (): void => {
      child.kill()
    },
  }
}

/**
 * Open a persistent ACP session (issue #605): spawn the agent (or connect the
 * injected test transport), initialize, and start a long-lived session. Unlike
 * the old one-turn flow, nothing is torn down when a prompt settles — the
 * process and session survive between turns, so the agent keeps its own
 * context (no transcript replay) and background helpers it spawned can finish.
 */
export async function openAcpSession(
  config: AcpAgentSpawnConfig,
  handlers: MutableAcpHandlers,
  createTransport: AcpTransportFactory = spawnTransport,
): Promise<OpenAcpSession> {
  const transport = await createTransport(config)

  const app = client({ name: 'copse' })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      const current = handlers.current
      if (!current) return { outcome: { outcome: 'cancelled' as const } }
      return current.requestPermission(ctx.params)
    })
    .onRequest(methods.client.fs.readTextFile, (ctx): Promise<ReadTextFileResponse> => {
      const readTextFile = handlers.current?.readTextFile
      return readTextFile ? readTextFile(ctx.params) : UNSUPPORTED('fs/read_text_file')()
    })
    .onRequest(methods.client.fs.writeTextFile, (ctx): Promise<WriteTextFileResponse> => {
      const writeTextFile = handlers.current?.writeTextFile
      return writeTextFile ? writeTextFile(ctx.params) : UNSUPPORTED('fs/write_text_file')()
    })

  const connection = app.connect(transport.stream)
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    connection.close()
    transport.dispose()
  }

  try {
    const initResponse = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const mcpCapabilities = initResponse.agentCapabilities?.mcpCapabilities
    const mcpServers = toAcpMcpServers(config.mcpServers ?? [], mcpCapabilities)
    // Copse's own tools ride the same channel as forwarded servers: an http
    // MCP endpoint the agent mounts itself (#602 tier 2). http-capable only —
    // agents without the capability simply don't get the bridge this session.
    if (config.nativeBridge && mcpCapabilities?.http === true) {
      mcpServers.push({
        type: 'http',
        name: 'copse',
        url: config.nativeBridge.url,
        headers: [{ name: 'Authorization', value: `Bearer ${config.nativeBridge.token}` }],
      })
    }
    const session = await connection.agent.buildSession({ cwd: config.cwd, mcpServers }).start()

    return {
      session,
      connection,
      handlers,
      mcpCapabilities,
      appliedModel: undefined,
      isClosed: () => disposed || connection.signal.aborted,
      dispose,
    }
  } catch (err) {
    dispose()
    throw err
  }
}

/**
 * How long to wait, after sending `session/cancel`, for the agent to settle its
 * prompt with a stop response before giving up on it. A well-behaved agent
 * answers the cancel promptly, so the turn ends within a few milliseconds and
 * the warm session is kept for reuse. But some adapters (e.g. Cursor's
 * `cursor-agent acp`) keep streaming or never respond to the cancel — without a
 * bound the turn would spin forever and the Stop button would appear to do
 * nothing. Once this grace elapses we tear the session down and report the turn
 * cancelled, so Stop always takes effect.
 */
export const ACP_CANCEL_GRACE_MS = 2000

/**
 * Run one prompt turn on a persistent session: apply a model change if the
 * picker's selection moved, send the prompt, and pump updates to the CURRENT
 * turn handlers until this turn's stop. Updates the agent queued between turns
 * (e.g. a background helper finishing) drain here first, so nothing is lost —
 * it just surfaces at the start of the next turn.
 *
 * Cancellation (`signal` abort, i.e. the Stop button): we send `session/cancel`
 * and stop forwarding the agent's chunks to the UI immediately, then keep
 * draining updates so a compliant agent's cancelled-stop is still consumed and
 * the session stays reusable. If the agent doesn't acknowledge within
 * {@link ACP_CANCEL_GRACE_MS}, we dispose the session (killing the stuck
 * process, which the pool respawns next turn) and report the turn cancelled.
 */
export async function runAcpSessionPrompt(
  open: OpenAcpSession,
  prompt: string,
  model: string | undefined,
  signal?: AbortSignal,
  cancelGraceMs: number = ACP_CANCEL_GRACE_MS,
): Promise<{ stopReason: StopReason; usage?: Usage | null }> {
  const { session, connection } = open

  // Resolves only once the user has aborted AND the agent has failed to settle
  // its prompt within the grace window — our cue to stop waiting on a stuck
  // agent rather than hang the turn forever.
  let onGraceExpired: (value: 'grace-expired') => void = () => {}
  const graceExpired = new Promise<'grace-expired'>((resolve) => {
    onGraceExpired = resolve
  })
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const cancel = (): void => {
    void connection.agent.notify('session/cancel', { sessionId: session.sessionId })
    graceTimer ??= setTimeout(() => {
      onGraceExpired('grace-expired')
    }, cancelGraceMs)
  }
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })

  try {
    if (!signal?.aborted && model && model !== open.appliedModel) {
      const selector = modelSelectorFrom(session.newSessionResponse)
      // Only switch when the value is a model the agent still offers and it
      // isn't already current. A stale/removed value (e.g. after an agent
      // version bump) is skipped, and a rejected set is swallowed, so a bad
      // model selection degrades to the agent's default instead of failing
      // the whole turn.
      const isKnown = selector?.choices.some((choice) => choice.value === model) ?? false
      if (selector && isKnown && model !== selector.currentValue) {
        try {
          await connection.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: selector.configId,
            value: model,
          })
          open.appliedModel = model
        } catch {
          // Fall back to the agent's current model for this turn.
        }
      } else {
        open.appliedModel = model
      }
    }

    // The turn's completion also arrives as a `stop` via nextUpdate(); we
    // swallow this promise's rejection because disposing the session on a
    // stuck cancel rejects the in-flight request, and the loop already settles
    // via the grace timer below.
    void session.prompt(prompt).catch(() => {})
    for (;;) {
      const message = await Promise.race([session.nextUpdate(), graceExpired])
      if (message === 'grace-expired') {
        // The agent never acknowledged the cancel. Tear the session down so the
        // stuck process can't keep the turn alive; the pool respawns next turn.
        open.dispose()
        return { stopReason: 'cancelled' }
      }
      if (message.kind === 'stop') return message.response
      // Once the user has aborted, stop surfacing further activity — the turn is
      // ending. We keep draining so a compliant agent's stop is still consumed.
      if (!signal?.aborted) {
        const chunk = sessionUpdateToStreamChunk(message.update)
        if (chunk) open.handlers.current?.onChunk(chunk)
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (graceTimer) clearTimeout(graceTimer)
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
