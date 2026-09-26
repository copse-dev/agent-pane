import type { AcpAgentSpawnConfig, AcpTransportFactory, OpenAcpSession } from './acp-client.ts'
import { openAcpSession, willSandboxAcpAgent } from './acp-client.ts'
import type { AcpSessionCarryOver, AcpSessionHandover } from './acp-session-reattach.ts'
import { acpSshTarget } from './acp-ssh-transport.ts'
import { startAcpNativeBridge, type AcpNativeBridge } from './acp-native-bridge.ts'
import { createAcpWireTrace } from './acp-wire-trace.ts'
import {
  formatOpenFileCeilingWarning,
  noteUnrepairableOpenFileFault,
} from './acp-resource-fault.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { notifyThreadResourceFinished } from '../worktree-parking-events.ts'
import { perfSpan } from '../diagnostics/perf-trace.ts'

/**
 * Per-thread pool of persistent ACP sessions (issue #605).
 *
 * The old flow spawned a fresh agent process per turn and killed it when the
 * prompt settled — so the agent had no memory (every turn re-paid a transcript
 * replay and re-exploration), and any background helper it spawned died with
 * the process, its results lost. The pool keeps one agent process + ACP
 * session alive per Copse thread:
 *
 * - Follow-up turns reuse the live session (no replay, background work
 *   survives; updates arriving between turns surface in the UI immediately
 *   via the session's update pump — see `startAcpUpdatePump` in acp-client.ts).
 * - After a dropped connection, an idle reap, **or a config change that forces
 *   a new process** — including a new working directory, as when a thread
 *   moves into its worktree — the replacement process reattaches to the same
 *   agent session with `session/resume` or `session/load` (issue #830,
 *   docs/plans/acp-session-continuity.md), so the agent keeps its own memory
 *   and the caller skips the transcript-replay preamble. When that is not
 *   possible the caller replays history once and is told why
 *   ({@link AcpSessionHandover}), so the thread can say what did not carry over.
 * - Sessions idle longer than {@link IDLE_MS} are reaped (process torn down to
 *   free resources); their session IDs are retained for the next acquire to
 *   reattach to. Everything is disposed at app shutdown.
 *
 * Lifetime consequences, on purpose: the native-tool bridge and the sandbox
 * network scope now live as long as the session (not one turn) — the M6-style
 * trade-off documented in `network-scope.ts` stretches accordingly, bounded by
 * the idle reaper.
 */

export interface PooledAcpSession {
  open: OpenAcpSession
  bridge: AcpNativeBridge | null
  fingerprint: string
  /** The cwd this process was spawned in — where its session last ran. */
  cwd: string
  /** {@link acpSessionLineage}: which sessions this process could take over. */
  lineage: string
  /** When this agent process was spawned — how a fault gets read (see below). */
  openedAt: number
  lastUsedAt: number
  dispose: () => Promise<void>
}

export interface AcquireAcpSessionOptions {
  projectId?: string
  threadId: string
  /** Spawn config WITHOUT `nativeBridge` — the pool starts/owns the bridge. */
  config: AcpAgentSpawnConfig
  /** Registry backing the native-tool bridge; absent = no bridge. */
  registry?: ToolRegistry | undefined
  /** Test seam: in-memory transport instead of spawning a process. */
  createTransport?: AcpTransportFactory | undefined
  /** Cancels run-owned startup prompts while opening a fresh transport. */
  signal?: AbortSignal | undefined
}

const IDLE_MS = 10 * 60 * 1000
const REAP_INTERVAL_MS = 60 * 1000

/**
 * How long an agent process must run before descriptor exhaustion reads as
 * something it did to itself. Past this age it plausibly leaked its way to the
 * ceiling, so a replacement — starting from an empty descriptor table — is
 * worth spawning. Under it, the process was in trouble almost from birth.
 */
const FAULT_REPLACE_MIN_AGE_MS = 60 * 1000

/**
 * Threads whose last agent process was replaced over a fault it hit young, and
 * so must not be replaced again for the same thing: a fresh process was already
 * tried and did no better, which means the ceiling both started from is the
 * problem and respawning is just churn. Cleared whenever a process survives
 * past {@link FAULT_REPLACE_MIN_AGE_MS}, so a slow leak keeps being repaired.
 */
const youngFaultReplaced = new Set<string>()

/** The ceiling warning names a machine-wide condition: once per run is enough. */
let ceilingWarned = false

const pool = new Map<string, PooledAcpSession>()
/**
 * The session each thread last had, once its process is gone (reaped, dropped,
 * or replaced), kept so the next acquire can reattach to it.
 */
interface CarryOverCandidate extends AcpSessionCarryOver {
  lineage: string
}
const carryOverCandidates = new Map<string, CarryOverCandidate>()
let reaper: NodeJS.Timeout | null = null

/** Everything that decides whether an existing session can serve this turn.
 * `model` is deliberately excluded — it switches live via set_config_option, and
 * so do the other `configOptions` (reasoning level, …), which are re-applied at
 * the start of each turn. `permissionMode` IS included (issue #607): unlike
 * those, it's applied once at `session/new`, so a change needs a fresh session
 * to take effect. */
export function acpSessionFingerprint(config: AcpAgentSpawnConfig): string {
  return JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    cwd: config.cwd,
    sandbox: config.sandbox ?? null,
    mcpServers: config.mcpServers ?? [],
    permissionMode: config.permissionMode ?? null,
  })
}

/**
 * What must stay the same for a new process to take over a thread's existing
 * agent session: the same agent (command, args, env) on the same machine.
 * Everything else in the fingerprint — cwd, sandbox, permission mode, MCP
 * servers — is supplied again when the session is reattached, so changing it
 * costs a process, not the conversation. A different host never inherits a
 * session, even from an identical command.
 */
export function acpSessionLineage(config: AcpAgentSpawnConfig): string {
  return JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    host: acpSshTarget(config.cwd)?.hostId ?? null,
  })
}

function ensureReaper(): void {
  if (reaper) return
  reaper = setInterval(() => {
    void reapIdleAcpSessions()
  }, REAP_INTERVAL_MS)
  reaper.unref()
}

/**
 * Remember the session a departing process held, so the next acquire can
 * reattach to it (#830). Kept whatever the agent advertises: one that can
 * neither resume nor load still needs to be known, so that losing it is
 * reported rather than silent.
 */
function rememberCarryOver(threadId: string, entry: PooledAcpSession): void {
  carryOverCandidates.set(threadId, {
    lineage: entry.lineage,
    sessionId: entry.open.session.sessionId,
    cwd: entry.cwd,
    hasHistory: entry.open.hasHistory,
  })
}

/** Evict sessions idle past `idleMs`. Exported with injectable `now` for tests. */
export async function reapIdleAcpSessions(now = Date.now(), idleMs = IDLE_MS): Promise<string[]> {
  const reaped: string[] = []
  for (const [threadId, entry] of pool) {
    // An in-flight turn (including one blocked on session/request_permission)
    // is not idle — reaping it closes the transport under the open approval
    // dialog and surfaces as "ACP connection closed" after a long wait.
    if (entry.open.turnStop !== null) continue
    if (now - entry.lastUsedAt >= idleMs) {
      // Tear down the live process, but keep the opaque session ID — the next
      // acquire spawns a fresh transport and reattaches with `session/resume`
      // or `session/load` instead of replaying the transcript (#830).
      rememberCarryOver(threadId, entry)
      pool.delete(threadId)
      await entry.dispose()
      reaped.push(threadId)
    }
  }
  return reaped
}

/**
 * Get the thread's live session, or open a fresh one. `fresh` tells the caller
 * whether the agent has no memory of this thread yet (replay history once);
 * `handover` says why, when it had a session with history that could not be
 * carried over.
 */
export async function acquireAcpSession(opts: AcquireAcpSessionOptions): Promise<{
  entry: PooledAcpSession
  fresh: boolean
  handover: AcpSessionHandover | null
}> {
  ensureReaper()
  const fingerprint = acpSessionFingerprint(opts.config)
  const lineage = acpSessionLineage(opts.config)

  const existing = pool.get(opts.threadId)
  if (existing) {
    // A process that ran out of file descriptors keeps answering, so nothing
    // else here would evict it — but everything it needs to open from now on
    // fails (see acp-resource-fault.ts). Replace it at this turn boundary; the
    // resume path below hands the same agent session to the fresh process, so
    // the descriptors come back without the thread losing the agent's memory.
    const fault = existing.open.resourceFault()
    const leakedIntoIt = Date.now() - existing.openedAt >= FAULT_REPLACE_MIN_AGE_MS
    // A faulted process never serves another turn if a fresh one could do
    // better — the user's next prompt would go to an agent that cannot open a
    // file. The one case where it is kept is when a replacement was already
    // tried for this thread and ran out just as fast: nothing Copse spawns will
    // clear that, so the alternative to reusing it is refusing to run at all.
    const replaceable = fault !== null && (leakedIntoIt || !youngFaultReplaced.has(opts.threadId))
    if (leakedIntoIt) youngFaultReplaced.delete(opts.threadId)
    if (fault && !replaceable) {
      noteUnrepairableOpenFileFault(opts.config.command, fault)
      if (!ceilingWarned) {
        ceilingWarned = true
        console.warn(formatOpenFileCeilingWarning(opts.config.command))
      }
    } else if (fault) {
      if (!leakedIntoIt) youngFaultReplaced.add(opts.threadId)
      console.warn(
        `[acp-pool] replacing thread ${opts.threadId}'s agent process: it reported ${fault.code} ` +
          `(${fault.detail})`,
      )
    }
    if (!replaceable && existing.fingerprint === fingerprint && !existing.open.isClosed()) {
      existing.lastUsedAt = Date.now()
      // Config options (reasoning level, …) are excluded from the fingerprint so
      // changing one reuses the session instead of respawning it; hand the fresh
      // selection to the open session, which applies the diff next turn.
      existing.open.desiredConfigOptions = opts.config.configOptions
      return { entry: existing, fresh: false, handover: null }
    }
    // Replaced — faulted, closed, or respawned for a new cwd, sandbox, or
    // permission mode. The departing process's session is the one to carry
    // over. The old process is disposed first: two processes must never write
    // one agent session.
    rememberCarryOver(opts.threadId, existing)
    pool.delete(opts.threadId)
    await existing.dispose()
  }
  // A different agent (or host) never inherits the session: that is a
  // conversation handed to someone else, which the transcript preamble covers.
  const candidate = carryOverCandidates.get(opts.threadId)
  const carryOver = candidate?.lineage === lineage ? candidate : undefined
  if (candidate && !carryOver) carryOverCandidates.delete(opts.threadId)

  // Bridge before spawn: a sandboxed agent's seatbelt profile must include
  // loopback at spawn time when the bridge will be offered (#602). The abort
  // controller cancels in-flight bridge tool executions at dispose.
  const bridgeAbort = new AbortController()
  const shareNetworkScope = willSandboxAcpAgent(opts.config.sandbox)
  // A bridge that fails to start used to resolve to null silently, which is
  // indistinguishable from an agent that simply was not offered one — the
  // failure mode behind #1430's "the agent ignored the attached archive".
  // Startup still must not abort the turn, so the error is logged, not thrown.
  const registry = opts.registry
  const bridge = registry
    ? await perfSpan('ttft:acp-bridge-start', () =>
        startAcpNativeBridge(registry, bridgeAbort.signal, {
          networkScopeAlreadyApplies: shareNetworkScope,
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          threadId: opts.threadId,
        }).catch((err: unknown) => {
          console.error(
            `[acp-bridge] failed to start for thread ${opts.threadId}; native tools will be unavailable this session:`,
            err instanceof Error ? err.message : String(err),
          )
          return null
        }),
      )
    : null
  if (!opts.registry) {
    console.warn(
      `[acp-bridge] no tool registry supplied for thread ${opts.threadId}; native tools will be unavailable this session`,
    )
  } else if (bridge) {
    // Keep the ordinary app log compact. The exact offered toolset is recorded
    // in the opt-in ACP diagnostic header below, where it can still answer why
    // an agent "did not use" a particular native tool.
    console.info(
      `[acp-bridge] offering ${String(bridge.toolNames.length)} native tool(s) to thread ${opts.threadId}`,
    )
  }
  const config: AcpAgentSpawnConfig = {
    ...opts.config,
    ...(bridge ? { nativeBridge: { url: bridge.url, token: bridge.token } } : {}),
  }

  // Opt-in ACP wire diagnostic (`COPSE_DEBUG_ACP_UPDATES=1`). Created here
  // because this is the layer that knows which thread the session belongs to,
  // and per session so a respawn/resume keeps appending to the same thread file
  // in wire order. `null` — always, when the flag is off — leaves the transport
  // untouched.
  const trace = await createAcpWireTrace({
    threadId: opts.threadId,
    agent: { command: opts.config.command, args: opts.config.args },
    ...(bridge ? { bridgeToolNames: bridge.toolNames } : {}),
  })

  let open: OpenAcpSession
  try {
    open = await perfSpan(
      'ttft:acp-open-session',
      () =>
        openAcpSession(
          config,
          { current: null },
          opts.createTransport,
          carryOver,
          trace,
          opts.signal,
        ),
      (value) => ({ resumed: value?.resumed ?? false }),
    )
  } catch (err) {
    bridgeAbort.abort()
    await bridge?.close()
    throw err
  }
  carryOverCandidates.delete(opts.threadId)

  let disposal: Promise<void> | null = null
  const entry: PooledAcpSession = {
    open,
    bridge,
    fingerprint,
    cwd: opts.config.cwd,
    lineage,
    openedAt: Date.now(),
    lastUsedAt: Date.now(),
    dispose: () => {
      if (disposal) return disposal
      open.dispose()
      bridgeAbort.abort()
      disposal = bridge?.close() ?? Promise.resolve()
      return disposal
    },
  }
  pool.set(opts.threadId, entry)
  const handover =
    carryOver?.hasHistory && open.carryOverFailure
      ? { reason: open.carryOverFailure, fromCwd: carryOver.cwd, toCwd: opts.config.cwd }
      : null
  if (handover) {
    console.warn(
      `[acp-pool] thread ${opts.threadId} could not carry its agent session into the new process ` +
        `(${handover.reason}${handover.fromCwd === handover.toCwd ? '' : ', cwd changed'}); ` +
        'continuing from the Copse transcript',
    )
  }
  return { entry, fresh: !open.resumed, handover }
}

/** Evict and tear down one thread's session (e.g. after a broken turn). */
export async function disposeAcpSession(
  threadId: string,
  options: { preserveForResume?: boolean } = {},
): Promise<boolean> {
  const entry = pool.get(threadId)
  if (!entry) {
    if (!options.preserveForResume) carryOverCandidates.delete(threadId)
    return false
  }
  if (options.preserveForResume) {
    rememberCarryOver(threadId, entry)
  } else {
    carryOverCandidates.delete(threadId)
  }
  pool.delete(threadId)
  await entry.dispose()
  notifyThreadResourceFinished(threadId)
  return true
}

/** Tear down every pooled session (app shutdown). */
export async function disposeAllAcpSessions(): Promise<void> {
  const entries = [...pool.values()]
  pool.clear()
  carryOverCandidates.clear()
  youngFaultReplaced.clear()
  if (reaper) {
    clearInterval(reaper)
    reaper = null
  }
  await Promise.all(entries.map((entry) => entry.dispose()))
}

/** Test/introspection helper. */
export function acpSessionPoolSize(): number {
  return pool.size
}
