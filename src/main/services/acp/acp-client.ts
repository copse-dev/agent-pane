import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ContentBlock,
  type McpCapabilities,
  type McpServer,
  type NewSessionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionModeState,
  type SessionUpdate,
  type StopReason,
  type Stream,
  type Usage,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { spawn, type ChildProcess } from 'node:child_process'
import { Writable } from 'node:stream'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { StreamChunk } from '@shared/types'
import type {
  AcpAgentProbe,
  AcpAgentSandboxConfig,
  AcpModeChoice,
  AcpModeSelector,
  AcpModelChoice,
  AcpModelSelector,
} from '@shared/types/acp.ts'
import { isRecord, recordArrayOrEmpty } from '@shared/unknown-value.ts'
import type { McpServerConfig } from '@shared/types/mcp.ts'
import { sessionUpdateToStreamChunk } from './session-update-adapter.ts'
import { cancelApprovalsForAcpToolCall } from '../approval.ts'
import { acpSshTarget, spawnRemoteAcpTransport } from './acp-ssh-transport.ts'
import { BRIDGE_MCP_SERVER_NAME } from './acp-native-bridge.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { acpAgentSandboxOverlay, ensureWorkspaceTmpDir } from '../../project-sandbox/config.ts'
import { acquireSandboxNetworkScope } from '../../project-sandbox/network-scope.ts'
import {
  formatArgvForShell,
  isProjectSandboxEnabled,
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
  withSandboxShellPath,
} from '../../project-sandbox/spawn.ts'

export type { AcpAgentProbe, AcpModeChoice, AcpModeSelector, AcpModelChoice, AcpModelSelector }

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
  requestPermission: (
    req: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>
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
   * Selected ACP **session mode** as a `SessionModeId` advertised in the
   * agent's `session/new` `modes` (issue #607). Applied via `session/set_mode`
   * immediately after the session is created — before the first prompt — so the
   * agent's own permission prompting is relaxed/tightened for the whole session.
   * Ignored when the agent advertises no modes, the id isn't offered, or it's
   * already the current mode.
   */
  permissionMode?: string
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
export function modelSelectorFrom(response: {
  configOptions?: readonly unknown[] | null
}): AcpModelSelector | null {
  const option = (response.configOptions ?? []).find(
    (candidate) =>
      isRecord(candidate) && candidate['category'] === 'model' && candidate['type'] === 'select',
  )
  if (!isRecord(option)) return null
  const configId = option['id']
  const currentValue = option['currentValue']
  if (typeof configId !== 'string' || typeof currentValue !== 'string') return null
  const choices: AcpModelChoice[] = []
  for (const entry of recordArrayOrEmpty(option['options'])) {
    if (typeof entry['group'] === 'string') {
      for (const sub of recordArrayOrEmpty(entry['options'])) {
        if (typeof sub['value'] === 'string' && typeof sub['name'] === 'string') {
          choices.push({ value: sub['value'], label: sub['name'] })
        }
      }
    } else if (typeof entry['value'] === 'string' && typeof entry['name'] === 'string') {
      choices.push({ value: entry['value'], label: entry['name'] })
    }
  }
  return { configId, currentValue, choices }
}

/**
 * Find the agent's session-mode selector in a `session/new` response, if any
 * (issue #607). ACP surfaces agent permission behavior as **session modes**: a
 * `modes` state with the current mode id and the set of `availableModes` the
 * agent can operate in (e.g. Claude Code's default / acceptEdits /
 * bypassPermissions / plan). Switched with `session/set_mode`. Returns `null`
 * when the agent advertises no modes (its prompting is then whatever it decides).
 */
export function modeSelectorFrom(response: {
  modes?: SessionModeState | null
}): AcpModeSelector | null {
  const modes = response.modes
  if (!modes || modes.availableModes.length === 0) return null
  const choices: AcpModeChoice[] = modes.availableModes.map((mode) => ({
    value: mode.id,
    label: mode.name,
    ...(mode.description ? { description: mode.description } : {}),
  }))
  return { currentValue: modes.currentModeId, choices }
}

/**
 * Apply an ACP session mode to a newly created or resumed session via `session/set_mode`
 * (issue #607). No-op when no mode is requested, the agent advertises no modes,
 * the requested id isn't one the agent offers, or it's already the current mode.
 * A rejected set is swallowed so a bad/stale mode selection degrades to the
 * agent's own default rather than failing the session.
 */
async function applySessionMode(
  connection: ClientConnection,
  session: ManagedAcpSession,
  permissionMode: string | undefined,
): Promise<void> {
  if (!permissionMode) return
  const selector = modeSelectorFrom(session.response)
  if (!selector) return
  const isKnown = selector.choices.some((choice) => choice.value === permissionMode)
  if (!isKnown || permissionMode === selector.currentValue) return
  try {
    await connection.agent.request(methods.agent.session.setMode, {
      sessionId: session.sessionId,
      modeId: permissionMode,
    })
  } catch {
    // Fall back to the agent's own default mode for this session.
  }
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

const ACP_STDERR_TAIL_LIMIT = 8_000

function appendStderrTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString()
  return next.length <= ACP_STDERR_TAIL_LIMIT ? next : next.slice(-ACP_STDERR_TAIL_LIMIT)
}

function acpProcessExitError(
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

function acpProcessSpawnError(command: string, err: Error, stderr: string): Error {
  const detail = stderr.trim()
  return new Error(
    `ACP agent "${command}" failed to start: ${err.message}${detail ? `. stderr: ${detail}` : ''}`,
  )
}

async function spawnAcpAgentProcess(config: AcpAgentSpawnConfig): Promise<ChildProcess> {
  const env = buildAcpAgentEnv(config)
  const stdio: 'pipe'[] = ['pipe', 'pipe', 'pipe']
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
      const child = spawn(resolveSandboxShellExecutable(file), argv.slice(1), {
        cwd: config.cwd,
        env: withSandboxShellPath({ ...env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir }),
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

/** How a settled prompt turn reports back: ACP's `PromptResponse` essentials. */
export interface AcpTurnStop {
  stopReason: StopReason
  usage?: Usage | null
}

/** The session state returned by either `session/new` or `session/resume`. */
export interface ManagedAcpSession {
  sessionId: string
  response: NewSessionResponse | ResumeSessionResponse
}

/**
 * Minimal async queue for session updates. The SDK only exposes this routing
 * through its `ActiveSession` wrapper, which cannot be reconstructed after a
 * raw `session/resume` response. Keeping the queue here lets new and resumed
 * sessions share one typed update pump.
 */
class AcpUpdateQueue {
  private readonly pending: SessionUpdate[] = []
  private waiter: {
    resolve: (update: SessionUpdate) => void
    reject: (reason: unknown) => void
  } | null = null
  private failure: Error | null = null

  enqueue(update: SessionUpdate): void {
    if (this.failure !== null) return
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter.resolve(update)
    } else {
      this.pending.push(update)
    }
  }

  next(): Promise<SessionUpdate> {
    const update = this.pending.shift()
    if (update) return Promise.resolve(update)
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise<SessionUpdate>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  fail(reason: Error): void {
    if (this.failure !== null) return
    this.failure = reason
    const waiter = this.waiter
    if (waiter) {
      this.waiter = null
      waiter.reject(reason)
    }
  }
}

function closedConnectionError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : 'ACP connection closed')
}

/**
 * A live, reusable connection + session to an external ACP agent. Created by
 * {@link openAcpSession}; drive turns with {@link runAcpSessionPrompt}; the
 * owner (the session pool) calls `dispose` on eviction.
 */
export interface OpenAcpSession {
  session: ManagedAcpSession
  connection: ClientConnection
  updates: AcpUpdateQueue
  handlers: MutableAcpHandlers
  mcpCapabilities: McpCapabilities | undefined
  /** Whether this agent advertised the optional `session/resume` capability. */
  canResume: boolean
  /**
   * Whether this agent advertised `promptCapabilities.image` — when true,
   * Copse forwards attached images as ACP image content blocks (issue #831).
   */
  promptImage: boolean
  /** True when this connection restored a prior ACP session rather than creating one. */
  resumed: boolean
  /** Last model applied via `session/set_config_option` (avoid re-sending). */
  appliedModel: string | undefined
  /**
   * When true the update pump consumes the agent's updates without forwarding
   * them to the UI. Set on turn abort (Stop button) so a cancelled agent's
   * trailing output stays hidden; cleared when the next turn starts.
   */
  suppressChunks: boolean
  /**
   * The in-flight turn's settle slot: the update pump resolves it with the
   * turn's `stop` response — strictly AFTER forwarding every update the agent
   * sent before stopping — or rejects it when the prompt fails. Null between
   * turns.
   */
  turnStop: {
    resolve: (response: AcpTurnStop) => void
    reject: (err: unknown) => void
  } | null
  /** True once the connection closed or the agent process died. */
  isClosed: () => boolean
  dispose: () => void
}

/** Transport injection point so tests can wire an in-process agent. */
export type AcpTransportFactory = (
  config: AcpAgentSpawnConfig,
) => Promise<{ stream: Stream; dispose: () => void }>

function acpChildStdoutStream(
  child: ChildProcess,
  command: string,
  stderrTail: () => string,
): ReadableStream<Uint8Array> {
  const stdout = child.stdout
  if (!stdout) throw new Error('ACP agent spawned without stdout pipe')
  let cancelRead = (): void => {
    child.kill()
  }
  return new ReadableStream<Uint8Array>({
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
          controller.error(acpProcessSpawnError(command, err, stderrTail()))
        })
      }
      const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (code === 0 && signal === null) {
          settle(() => {
            controller.close()
          })
        } else {
          settle(() => {
            controller.error(acpProcessExitError(command, code, signal, stderrTail()))
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
}

function captureAcpChildStderr(child: ChildProcess, command: string): () => string {
  let tail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = appendStderrTail(tail, chunk)
    const text = chunk.toString().trimEnd()
    if (text) console.warn(`[acp:${command}] ${text}`)
  })
  return () => tail
}

async function spawnTransport(
  config: AcpAgentSpawnConfig,
): Promise<{ stream: Stream; dispose: () => void }> {
  // When the active project is an SSH workspace and the user opted in, spawn the
  // agent on the remote host (stdio over SSH) instead of locally — see
  // docs/plans/acp-over-ssh.md. Otherwise fall through to the local spawn.
  const sshTarget = acpSshTarget(config.cwd)
  if (sshTarget) return spawnRemoteAcpTransport(config, sshTarget)
  const child = await spawnAcpAgentProcess(config)
  if (!child.stdin) throw new Error('ACP agent spawned without stdin pipe')
  const stderrTail = captureAcpChildStderr(child, config.command)
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = acpChildStdoutStream(child, config.command, stderrTail)
  return {
    stream: ndJsonStream(writable, readable),
    dispose: (): void => {
      child.kill()
    },
  }
}

/**
 * The session's single consumer of the update queue, running from open to
 * dispose (issue #588). Exactly one loop may consume it — this pump owns that
 * role for the session's whole life, which is what lets updates arriving
 * BETWEEN turns (a background subagent finishing after its turn ended) surface
 * in the UI immediately instead of queueing invisibly until the user's next
 * message.
 *
 * Routing:
 * - Updates translate to chunks and go to the CURRENT (or, between turns, the
 *   most recent) handlers — unless {@link OpenAcpSession.suppressChunks} is set
 *   by an aborted turn.
 * - A rejected queue means the connection closed (pump exits). Prompt responses
 *   settle turns directly, after their request resolves.
 */
function startAcpUpdatePump(open: OpenAcpSession): void {
  void (async (): Promise<void> => {
    for (;;) {
      let update: SessionUpdate
      try {
        update = await open.updates.next()
      } catch (err) {
        if (open.isClosed()) return
        open.turnStop?.reject(err)
        continue
      }
      if (open.suppressChunks) continue
      try {
        // Dismiss a permission modal as soon as the agent marks that tool call
        // terminal — including `cancelled`, which has no UI chunk.
        if (
          update.sessionUpdate === 'tool_call_update' &&
          (update.status === 'completed' ||
            update.status === 'failed' ||
            update.status === 'cancelled')
        ) {
          cancelApprovalsForAcpToolCall(update.toolCallId)
        }
        const chunk = sessionUpdateToStreamChunk(update)
        if (chunk) open.handlers.current?.onChunk(chunk)
      } catch {
        // A sink failure must not kill the pump: turn-stop routing (and every
        // future turn on this session) depends on the loop staying alive.
      }
    }
  })()
}

/**
 * Open a persistent ACP session (issue #605): spawn the agent (or connect the
 * injected test transport), initialize, and start a long-lived session. Unlike
 * the old one-turn flow, nothing is torn down when a prompt settles — the
 * process and session survive between turns, so the agent keeps its own
 * context (no transcript replay) and background helpers it spawned can finish,
 * with their updates surfacing live through the session's update pump.
 */
export async function openAcpSession(
  config: AcpAgentSpawnConfig,
  handlers: MutableAcpHandlers,
  createTransport: AcpTransportFactory = spawnTransport,
  resumeSessionId?: string,
): Promise<OpenAcpSession> {
  const transport = await createTransport(config)

  let activeUpdates: { sessionId: string; queue: AcpUpdateQueue } | null = null
  const pendingUpdates = new Map<string, SessionUpdate[]>()

  const app = client({ name: 'copse' })
    .onNotification(methods.client.session.update, (ctx) => {
      const { sessionId, update } = ctx.params
      if (activeUpdates?.sessionId === sessionId) {
        activeUpdates.queue.enqueue(update)
        return
      }
      const pending = pendingUpdates.get(sessionId) ?? []
      pending.push(update)
      pendingUpdates.set(sessionId, pending)
    })
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      const current = handlers.current
      if (!current) return { outcome: { outcome: 'cancelled' as const } }
      try {
        return await current.requestPermission(ctx.params, ctx.signal)
      } catch (err) {
        if (ctx.signal.aborted) return { outcome: { outcome: 'cancelled' as const } }
        throw err
      }
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
    const canResume = Boolean(initResponse.agentCapabilities?.sessionCapabilities?.resume)
    const promptImage = initResponse.agentCapabilities?.promptCapabilities?.image === true
    const mcpServers = toAcpMcpServers(config.mcpServers ?? [], mcpCapabilities)
    // Copse's own tools ride the same channel as forwarded servers: an http
    // MCP endpoint the agent mounts itself (#602 tier 2). http-capable only —
    // agents without the capability simply don't get the bridge this session.
    if (config.nativeBridge && mcpCapabilities?.http === true) {
      mcpServers.push({
        type: 'http',
        name: BRIDGE_MCP_SERVER_NAME,
        url: config.nativeBridge.url,
        headers: [{ name: 'Authorization', value: `Bearer ${config.nativeBridge.token}` }],
      })
    }
    let session: ManagedAcpSession | null = null
    let resumed = false
    if (resumeSessionId && canResume) {
      try {
        const response: ResumeSessionResponse = await connection.agent.request(
          methods.agent.session.resume,
          { sessionId: resumeSessionId, cwd: config.cwd, mcpServers },
        )
        session = { sessionId: resumeSessionId, response }
        resumed = true
      } catch {
        // A session can expire while its client is disconnected. Fall back to a
        // fresh session below; the pool will replay Copse's transcript once.
      }
    }
    if (!session) {
      const response = await connection.agent.request(methods.agent.session.new, {
        cwd: config.cwd,
        mcpServers,
      })
      session = { sessionId: response.sessionId, response }
    }
    const updates = new AcpUpdateQueue()
    for (const update of pendingUpdates.get(session.sessionId) ?? []) updates.enqueue(update)
    pendingUpdates.clear()
    activeUpdates = { sessionId: session.sessionId, queue: updates }
    // Relax/tighten the agent's own permission prompting for the whole session
    // (issue #607) — e.g. a sandboxed Claude preset runs in `acceptEdits` since
    // the seatbelt already contains writes. Applied here, before the first
    // prompt, so the session's first tool call already honors the mode.
    await applySessionMode(connection, session, config.permissionMode)

    const open: OpenAcpSession = {
      session,
      connection,
      updates,
      handlers,
      mcpCapabilities,
      canResume,
      promptImage,
      resumed,
      appliedModel: undefined,
      suppressChunks: false,
      turnStop: null,
      isClosed: () => disposed || connection.signal.aborted,
      dispose,
    }
    connection.signal.addEventListener(
      'abort',
      () => {
        const reason = closedConnectionError(connection.signal.reason)
        updates.fail(reason)
        open.turnStop?.reject(reason)
      },
      { once: true },
    )
    startAcpUpdatePump(open)
    return open
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
 * Normalize a string or content-block prompt into the ACP `session/prompt`
 * shape. Strings stay one text block (existing tests / call sites); arrays
 * pass through so image blocks (issue #831) are kept.
 */
export function toAcpPromptBlocks(prompt: string | ContentBlock[]): ContentBlock[] {
  return typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt
}

/**
 * Run one prompt turn on a persistent session: apply a model change if the
 * picker's selection moved, send the prompt, and wait for the turn's stop. The
 * agent's updates — this turn's and any that arrive between turns — are
 * forwarded to the UI by the session's update pump (see
 * {@link startAcpUpdatePump}). The prompt response settles this turn after the
 * agent completes the request.
 *
 * `prompt` may be a plain string (one text block) or a full ACP content-block
 * array — use the latter when forwarding images (issue #831).
 *
 * Cancellation (`signal` abort, i.e. the Stop button): we send `session/cancel`
 * and stop forwarding the agent's chunks to the UI immediately
 * (`suppressChunks`), while the pump keeps consuming so a compliant agent's
 * cancelled-stop is still processed and the session stays reusable. If the
 * agent doesn't acknowledge within {@link ACP_CANCEL_GRACE_MS}, we dispose the
 * session (killing the stuck process, which the pool respawns next turn) and
 * report the turn cancelled.
 */
export async function runAcpSessionPrompt(
  open: OpenAcpSession,
  prompt: string | ContentBlock[],
  model: string | undefined,
  signal?: AbortSignal,
  cancelGraceMs: number = ACP_CANCEL_GRACE_MS,
): Promise<AcpTurnStop> {
  const { session, connection } = open
  const promptBlocks = toAcpPromptBlocks(prompt)

  // Resolves only once the user has aborted AND the agent has failed to settle
  // its prompt within the grace window — our cue to stop waiting on a stuck
  // agent rather than hang the turn forever.
  let onGraceExpired: (value: 'grace-expired') => void = () => {}
  const graceExpired = new Promise<'grace-expired'>((resolve) => {
    onGraceExpired = resolve
  })
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const cancel = (): void => {
    open.suppressChunks = true
    void connection.agent.notify('session/cancel', { sessionId: session.sessionId })
    graceTimer ??= setTimeout(() => {
      onGraceExpired('grace-expired')
    }, cancelGraceMs)
  }

  // New turn: surface chunks again (a cancelled previous turn left them
  // suppressed) and install the slot the update pump settles on this turn's
  // stop. Install BEFORE wiring the abort path so an already-aborted signal
  // re-suppresses.
  open.suppressChunks = false
  let settleStop!: NonNullable<OpenAcpSession['turnStop']>
  const stopped = new Promise<AcpTurnStop>((resolve, reject) => {
    settleStop = { resolve, reject }
  })
  // The grace-expired path abandons `stopped`; swallow its late rejection (the
  // disposed connection rejects the in-flight prompt) so it never surfaces as
  // an unhandled rejection.
  void stopped.catch(() => {})
  open.turnStop = settleStop

  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })

  try {
    if (!signal?.aborted && model && model !== open.appliedModel) {
      const selector = modelSelectorFrom(session.response)
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

    void connection.agent
      .request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: promptBlocks,
      })
      .then(settleStop.resolve, settleStop.reject)
    const outcome = await Promise.race([stopped, graceExpired])
    if (outcome === 'grace-expired') {
      // The agent never acknowledged the cancel. Tear the session down so the
      // stuck process can't keep the turn alive; the pool respawns next turn.
      open.dispose()
      return { stopReason: 'cancelled' }
    }
    return outcome
  } finally {
    open.turnStop = null
    signal?.removeEventListener('abort', cancel)
    if (graceTimer) clearTimeout(graceTimer)
  }
}

/**
 * Probe an external ACP agent for what it offers the settings picker: its
 * selectable models AND its session (permission) modes (issue #607). Spawns the
 * agent, initializes, opens a throwaway session, reads both the `category:
 * "model"` config option and the `modes` state, and tears the process down.
 * Each selector is `null` when the agent exposes none of that kind.
 *
 * This is a probe, not a turn: no prompt is sent, so it does not consume model
 * tokens — but it does start the agent process (and may trigger its auth), so
 * call it on demand (a "Detect models" action), not on every picker open.
 */
export async function probeAcpAgent(
  config: AcpAgentSpawnConfig,
  timeoutMs = 15000,
): Promise<AcpAgentProbe> {
  const child = await spawnAcpAgentProcess(config)
  if (!child.stdin) throw new Error('ACP agent spawned without stdin pipe')
  const stderrTail = captureAcpChildStderr(child, config.command)
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = acpChildStdoutStream(child, config.command, stderrTail)
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
        const probe: AcpAgentProbe = {
          models: modelSelectorFrom(session.newSessionResponse),
          modes: modeSelectorFrom(session.newSessionResponse),
        }
        void ctx.notify('session/cancel', { sessionId: session.sessionId })
        return probe
      })
    })
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}
