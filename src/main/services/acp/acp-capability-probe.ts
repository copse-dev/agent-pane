import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSessionMessage,
  type AgentCapabilities,
  type InitializeResponse,
  type NewSessionResponse,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

/**
 * Tier-1 ACP **capability probe** (issue #264): spawn an external ACP agent,
 * run `initialize` + `session/new`, record everything it negotiates, and tear
 * it down — WITHOUT ever sending a `session/prompt`. No model tokens are spent
 * and (for well-behaved adapters) no auth is required, so this is the cheap,
 * near-deterministic half of the ACP evaluation harness. The behavioural half
 * (write routing, permission payloads, `_meta` under real turns) is Tier 2 and
 * lives elsewhere.
 *
 * Why this exists: the spec makes almost every feature an OPTIONAL capability or
 * an explicitly UNSTABLE extension (`loadSession`, `promptCapabilities`,
 * `sessionCapabilities`, usage, modes, …), so what a given agent+adapter
 * actually supports — and what it tunnels through the reserved `_meta` field —
 * can only be learned empirically. This probe turns that into data: a support
 * matrix keyed by agent and adapter version.
 *
 * Unlike the real client path (`acp-client.ts`), the probe spawns the agent
 * UNSANDBOXED and without scrubbing Copse's provider keys. That is deliberate
 * and safe for a probe: it sends no prompt, so no model turn runs; it only reads
 * the connection-time negotiation. Keep it that way — do not grow a prompt here.
 */

/** A single authentication method the agent advertised in `initialize`. */
export interface AcpAuthMethodInfo {
  id: string
  name: string
}

/**
 * The structured, comparable slice of an agent's negotiated capabilities. Every
 * field is derived from `initialize` / `session/new` (plus a best-effort drain
 * of updates the agent pushes on connect); nothing here requires a prompt.
 */
export interface AcpCapabilitySnapshot {
  /** Protocol version the agent settled on. */
  protocolVersion: number
  /** Agent/adapter name and version from `initialize` `agentInfo`, when sent. */
  agentInfo: { name: string; title: string | null; version: string } | null

  // Session lifecycle (AgentCapabilities + SessionCapabilities).
  loadSession: boolean
  sessionList: boolean
  sessionDelete: boolean
  sessionResume: boolean
  sessionClose: boolean
  /** UNSTABLE in the spec. */
  sessionFork: boolean
  additionalDirectories: boolean

  // Prompt content (PromptCapabilities).
  promptImage: boolean
  promptAudio: boolean
  promptEmbeddedContext: boolean

  // MCP transports the agent will accept over `session/new` (McpCapabilities).
  mcpHttp: boolean
  mcpSse: boolean
  /** UNSTABLE in the spec. */
  mcpAcp: boolean

  /** Session modes advertised on `session/new`, if any. */
  modes: { current: string; available: string[] } | null
  /**
   * Model selector exposed as a `category: "model"` config option, if any.
   * `count` is the number of selectable models; `current` is the default.
   */
  models: { current: string | null; count: number; sample: string[] } | null

  /** Authentication methods offered in `initialize`. */
  authMethods: AcpAuthMethodInfo[]

  /**
   * Slash/available commands seen while draining post-connect updates. Empty
   * when the agent sends none in the settle window — best-effort, not proof of
   * absence (some agents only announce commands after the first prompt).
   */
  slashCommands: string[]
  /**
   * `sessionUpdate` kinds the agent pushed unsolicited on connect, e.g.
   * `available_commands_update`, `current_mode_update`. A rough signal of what
   * the agent volunteers before any turn.
   */
  observedUpdateKinds: string[]

  /** Names of UNSTABLE capabilities the agent advertised (for visibility). */
  unstableCapabilities: string[]

  /**
   * Verbatim `_meta` payloads harvested from the initialize and session/new
   * responses — where vendor adapters tunnel non-spec extensions. Kept raw so
   * the snapshot loses nothing; `metaKeys` is the flattened key list for the
   * matrix.
   */
  meta: {
    initialize: Record<string, unknown> | null
    newSession: Record<string, unknown> | null
  }
  metaKeys: string[]

  /** The full, verbatim `AgentCapabilities` object, for the JSON snapshot. */
  rawAgentCapabilities: AgentCapabilities | null
}

/** The result of probing one agent: either a snapshot, or the error that broke it. */
export interface AcpCapabilityReport {
  /** Configured agent id (`acp:<id>`). */
  agentId: string
  /** Human-readable title for the matrix. */
  title: string
  /** Command that was spawned. */
  command: string
  args: string[]
  /** ISO timestamp; set by the caller when assembling a matrix. */
  probedAt?: string
  /**
   * Protocol version we asked for in `initialize`. The agent negotiates DOWN to
   * a version it supports (see {@link AcpCapabilitySnapshot.protocolVersion} for
   * what it actually settled on). Defaults to the SDK's `PROTOCOL_VERSION` (v1);
   * request a higher version to probe how an agent handles / downgrades a newer
   * request once the SDK can speak it.
   */
  requestedProtocolVersion: number
  /** True when initialize + session/new completed and a snapshot was produced. */
  ok: boolean
  /** Populated when `ok` is false. */
  error?: string
  /** The negotiated capabilities; present iff `ok`. */
  snapshot?: AcpCapabilitySnapshot
}

/** Config for spawning the agent to probe. Mirrors the client's spawn shape. */
export interface AcpProbeConfig {
  agentId: string
  title: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Absolute workspace root passed as the ACP session `cwd`. */
  cwd: string
}

export interface AcpProbeOptions {
  /**
   * How long to wait after `session/new` for the agent to push unsolicited
   * updates (available commands, current mode). 0 skips the drain entirely for
   * a purely synchronous probe. Default 750ms.
   */
  settleMs?: number
  /** Overall timeout for the whole probe before the agent is killed. Default 20s. */
  timeoutMs?: number
  /**
   * Protocol version to request in `initialize`. Defaults to the SDK's
   * `PROTOCOL_VERSION`. This is the forward hook for ACP v2: once the pinned SDK
   * can speak a newer protocol, bumping this (via `--protocol`) probes it with no
   * other change. Today the SDK is v1-only, so a higher value just reveals how
   * each agent negotiates a newer request down.
   */
  protocolVersion?: number
  /** Transport injection point so tests can wire an in-process agent. */
  createTransport?: (config: AcpProbeConfig) => Promise<{ stream: Stream; dispose: () => void }>
}

/** Collect the string keys of a `_meta`-style record, or `[]` when absent. */
function metaKeysOf(meta: Record<string, unknown> | null | undefined): string[] {
  return meta ? Object.keys(meta) : []
}

/** Normalize an ACP `_meta` value (may be `null`) to a plain record or `null`. */
function normalizeMeta(
  meta: { [k: string]: unknown } | null | undefined,
): Record<string, unknown> | null {
  return meta ?? null
}

/**
 * Derive the comparable {@link AcpCapabilitySnapshot} from the raw protocol
 * responses. Pure and side-effect-free: this is the unit-tested core, and the
 * orchestration below just feeds it real wire data.
 */
export function extractCapabilitySnapshot(
  init: InitializeResponse,
  newSession: NewSessionResponse,
  observedUpdates: readonly SessionUpdate[] = [],
): AcpCapabilitySnapshot {
  const caps = init.agentCapabilities ?? null
  const prompt = caps?.promptCapabilities
  const mcp = caps?.mcpCapabilities
  const session = caps?.sessionCapabilities

  // A capability object present (even `{}`) means "supported"; absent/null means not.
  const has = (value: unknown): boolean => value !== undefined && value !== null

  const unstable: string[] = []
  if (has(caps?.providers)) unstable.push('providers')
  if (has(caps?.nes)) unstable.push('nes')
  if (has(session?.fork)) unstable.push('sessionCapabilities.fork')
  if (mcp?.acp === true) unstable.push('mcpCapabilities.acp')

  const modes = newSession.modes
    ? {
        current: newSession.modes.currentModeId,
        available: newSession.modes.availableModes.map((mode) => mode.id),
      }
    : null

  const models = extractModelSummary(newSession)

  const authMethods: AcpAuthMethodInfo[] = (init.authMethods ?? []).map((method) => ({
    id: method.id,
    name: method.name,
  }))

  // Best-effort: pull available commands and update kinds from what the agent
  // volunteered on connect.
  const slashCommands: string[] = []
  const observedUpdateKinds: string[] = []
  for (const update of observedUpdates) {
    if (!observedUpdateKinds.includes(update.sessionUpdate)) {
      observedUpdateKinds.push(update.sessionUpdate)
    }
    if (update.sessionUpdate === 'available_commands_update') {
      for (const command of update.availableCommands) {
        if (!slashCommands.includes(command.name)) slashCommands.push(command.name)
      }
    }
  }

  const initMeta = normalizeMeta(init._meta)
  const newSessionMeta = normalizeMeta(newSession._meta)
  const metaKeys = [
    ...metaKeysOf(initMeta).map((key) => `initialize:${key}`),
    ...metaKeysOf(newSessionMeta).map((key) => `session/new:${key}`),
  ]

  return {
    protocolVersion: init.protocolVersion,
    agentInfo: init.agentInfo
      ? {
          name: init.agentInfo.name,
          title: init.agentInfo.title ?? null,
          version: init.agentInfo.version,
        }
      : null,

    loadSession: caps?.loadSession === true,
    sessionList: has(session?.list),
    sessionDelete: has(session?.delete),
    sessionResume: has(session?.resume),
    sessionClose: has(session?.close),
    sessionFork: has(session?.fork),
    additionalDirectories: has(session?.additionalDirectories),

    promptImage: prompt?.image === true,
    promptAudio: prompt?.audio === true,
    promptEmbeddedContext: prompt?.embeddedContext === true,

    mcpHttp: mcp?.http === true,
    mcpSse: mcp?.sse === true,
    mcpAcp: mcp?.acp === true,

    modes,
    models,
    authMethods,
    slashCommands,
    observedUpdateKinds,
    unstableCapabilities: unstable,
    meta: { initialize: initMeta, newSession: newSessionMeta },
    metaKeys,
    rawAgentCapabilities: caps,
  }
}

/**
 * Summarize the agent's model selector from a `session/new` response. Mirrors
 * `modelSelectorFrom` in acp-client.ts (a `category: "model"`, `type: "select"`
 * config option, options possibly grouped) but returns a compact summary for
 * the matrix rather than the full picker model.
 */
function extractModelSummary(
  newSession: NewSessionResponse,
): { current: string | null; count: number; sample: string[] } | null {
  const option = (newSession.configOptions ?? []).find(
    (candidate) => candidate.category === 'model' && candidate.type === 'select',
  )
  if (!option || option.type !== 'select') return null
  const values: string[] = []
  for (const entry of option.options) {
    if ('group' in entry) {
      for (const sub of entry.options) values.push(sub.name)
    } else {
      values.push(entry.name)
    }
  }
  return {
    current: option.currentValue,
    count: values.length,
    sample: values.slice(0, 8),
  }
}

const UNSUPPORTED = (method: string) => (): Promise<never> =>
  Promise.reject(new Error(`Client capability not enabled during probe: ${method}`))

/** Default transport: spawn the agent process and frame stdio as ndjson. */
function spawnProbeTransport(
  config: AcpProbeConfig,
): Promise<{ stream: Stream; dispose: () => void }> {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: { ...process.env, ...(config.env ?? {}) },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  // `stdio: ['pipe', 'pipe', ...]` types stdin/stdout as non-null.
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  return Promise.resolve({
    stream: ndJsonStream(writable, readable),
    dispose: (): void => {
      child.kill()
    },
  })
}

/**
 * Drain updates the agent pushes for up to `settleMs`, never blocking past it.
 * With no prompt in flight the agent may push nothing (then this returns []),
 * or announce its commands/mode (well-behaved adapters do). A `stop` message is
 * unexpected without a prompt and ends the drain.
 */
async function drainUpdates(
  nextUpdate: () => Promise<ActiveSessionMessage>,
  settleMs: number,
): Promise<SessionUpdate[]> {
  if (settleMs <= 0) return []
  const collected: SessionUpdate[] = []
  const deadline = Date.now() + settleMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const next = nextUpdate()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => {
        res('timeout')
      }, remaining)
    })
    const outcome = await Promise.race([next, timeout])
    if (timer) clearTimeout(timer)
    if (outcome === 'timeout') {
      // Abandon the pending waiter; the connection is torn down right after.
      void next.catch(() => {})
      break
    }
    // A `stop` is unexpected without a prompt in flight; end the drain.
    if (outcome.kind !== 'session_update') break
    collected.push(outcome.update)
  }
  return collected
}

/**
 * Probe one agent: spawn (or connect an injected transport), initialize, open a
 * throwaway session, snapshot capabilities, and tear down. Never throws — a
 * spawn/handshake failure is captured as `{ ok: false, error }` so a matrix run
 * over several agents keeps going.
 */
export async function probeAgentCapabilities(
  config: AcpProbeConfig,
  options: AcpProbeOptions = {},
): Promise<AcpCapabilityReport> {
  const settleMs = options.settleMs ?? 750
  const timeoutMs = options.timeoutMs ?? 20_000
  const requestedProtocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
  const createTransport = options.createTransport ?? spawnProbeTransport

  const base = {
    agentId: config.agentId,
    title: config.title,
    command: config.command,
    args: config.args ?? [],
    requestedProtocolVersion,
  }

  let transport: { stream: Stream; dispose: () => void } | null = null
  // Mutated only inside the timeout closure, so a plain `let` would be
  // control-flow-narrowed to `false` at the read site below. An object property
  // keeps its declared type across the async boundary.
  const state = { timedOut: false }
  const timer = setTimeout(() => {
    state.timedOut = true
    transport?.dispose()
  }, timeoutMs)

  try {
    transport = await createTransport(config)
    const app = client({ name: 'copse-probe' })
      .onRequest(methods.client.fs.readTextFile, UNSUPPORTED('fs/read_text_file'))
      .onRequest(methods.client.fs.writeTextFile, UNSUPPORTED('fs/write_text_file'))

    const snapshot = await app.connectWith(transport.stream, async (ctx) => {
      const init = await ctx.request(methods.agent.initialize, {
        protocolVersion: requestedProtocolVersion,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      return ctx.buildSession(config.cwd).withSession(async (session) => {
        const observed = await drainUpdates(() => session.nextUpdate(), settleMs)
        // Best-effort tidy close; the process is killed in `finally` regardless.
        void ctx.notify('session/cancel', { sessionId: session.sessionId })
        return extractCapabilitySnapshot(init, session.newSessionResponse, observed)
      })
    })

    return { ...base, ok: true, snapshot }
  } catch (err) {
    const reason = state.timedOut
      ? `timed out after ${String(timeoutMs)}ms`
      : err instanceof Error
        ? err.message
        : String(err)
    return { ...base, ok: false, error: reason }
  } finally {
    clearTimeout(timer)
    transport?.dispose()
  }
}
