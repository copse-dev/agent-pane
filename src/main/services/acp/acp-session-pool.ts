import type { AcpAgentSpawnConfig, AcpTransportFactory, OpenAcpSession } from './acp-client.ts'
import { openAcpSession, willSandboxAcpAgent } from './acp-client.ts'
import { startAcpNativeBridge, type AcpNativeBridge } from './acp-native-bridge.ts'
import type { ToolRegistry } from '../tool-registry.ts'

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
 * - After a dropped connection **or an idle reap**, agents that advertise
 *   `session/resume` restore the same session on a replacement transport
 *   (issue #830) — so the agent keeps its own memory and the caller skips the
 *   transcript-replay preamble. If resuming is unavailable or rejected, or a
 *   config change forces a genuinely new session, the caller replays history
 *   once.
 * - Sessions idle longer than {@link IDLE_MS} are reaped (process torn down to
 *   free resources); resume-capable session IDs are retained for the next
 *   acquire. Everything is disposed at app shutdown.
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
  lastUsedAt: number
  dispose: () => Promise<void>
}

export interface AcquireAcpSessionOptions {
  threadId: string
  /** Spawn config WITHOUT `nativeBridge` — the pool starts/owns the bridge. */
  config: AcpAgentSpawnConfig
  /** Registry backing the native-tool bridge; absent = no bridge. */
  registry?: ToolRegistry | undefined
  /** Test seam: in-memory transport instead of spawning a process. */
  createTransport?: AcpTransportFactory | undefined
}

const IDLE_MS = 10 * 60 * 1000
const REAP_INTERVAL_MS = 60 * 1000

const pool = new Map<string, PooledAcpSession>()
/** Session IDs retained only long enough to reconnect after a transport drop. */
const resumeCandidates = new Map<string, { fingerprint: string; sessionId: string }>()
let reaper: NodeJS.Timeout | null = null

/** Everything that decides whether an existing session can serve this turn.
 * `model` is deliberately excluded — it switches live via set_config_option.
 * `permissionMode` IS included (issue #607): unlike model, it's applied once at
 * `session/new`, so a change needs a fresh session to take effect. */
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

function ensureReaper(): void {
  if (reaper) return
  reaper = setInterval(() => {
    void reapIdleAcpSessions()
  }, REAP_INTERVAL_MS)
  reaper.unref()
}

/**
 * Remember a session ID for a later `session/resume` attempt, if the agent
 * advertised the capability. Used after a transport drop and after idle reap
 * (#830) so the next acquire can restore agent memory without a Copse-side
 * transcript replay.
 */
function rememberResumeCandidate(threadId: string, entry: PooledAcpSession): void {
  if (!entry.open.canResume) {
    resumeCandidates.delete(threadId)
    return
  }
  resumeCandidates.set(threadId, {
    fingerprint: entry.fingerprint,
    sessionId: entry.open.session.sessionId,
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
      // Tear down the live process, but keep the opaque session ID when the
      // agent can resume — the next acquire spawns a fresh transport and calls
      // `session/resume` instead of replaying the transcript (#830).
      rememberResumeCandidate(threadId, entry)
      pool.delete(threadId)
      await entry.dispose()
      reaped.push(threadId)
    }
  }
  return reaped
}

/**
 * Get the thread's live session, or open a fresh one. `fresh` tells the caller
 * whether the agent has no memory of this thread yet (replay history once).
 */
export async function acquireAcpSession(
  opts: AcquireAcpSessionOptions,
): Promise<{ entry: PooledAcpSession; fresh: boolean }> {
  ensureReaper()
  const fingerprint = acpSessionFingerprint(opts.config)
  let resumeSessionId: string | undefined

  const existing = pool.get(opts.threadId)
  if (existing) {
    if (existing.fingerprint === fingerprint && !existing.open.isClosed()) {
      existing.lastUsedAt = Date.now()
      return { entry: existing, fresh: false }
    }
    if (existing.fingerprint === fingerprint && existing.open.canResume) {
      resumeSessionId = existing.open.session.sessionId
    } else {
      resumeCandidates.delete(opts.threadId)
    }
    pool.delete(opts.threadId)
    await existing.dispose()
  }
  const candidate = resumeCandidates.get(opts.threadId)
  if (candidate?.fingerprint === fingerprint) {
    resumeSessionId ??= candidate.sessionId
  } else if (candidate) {
    resumeCandidates.delete(opts.threadId)
  }

  // Bridge before spawn: a sandboxed agent's seatbelt profile must include
  // loopback at spawn time when the bridge will be offered (#602). The abort
  // controller cancels in-flight bridge tool executions at dispose.
  const bridgeAbort = new AbortController()
  const shareNetworkScope = willSandboxAcpAgent(opts.config.sandbox)
  // A bridge that fails to start used to resolve to null silently, which is
  // indistinguishable from an agent that simply was not offered one — the
  // failure mode behind #1430's "the agent ignored the attached archive".
  // Startup still must not abort the turn, so the error is logged, not thrown.
  const bridge = opts.registry
    ? await startAcpNativeBridge(opts.registry, bridgeAbort.signal, {
        networkScopeAlreadyApplies: shareNetworkScope,
        threadId: opts.threadId,
      }).catch((err: unknown) => {
        console.error(
          `[acp-bridge] failed to start for thread ${opts.threadId}; native tools will be unavailable this session:`,
          err instanceof Error ? err.message : String(err),
        )
        return null
      })
    : null
  if (!opts.registry) {
    console.warn(
      `[acp-bridge] no tool registry supplied for thread ${opts.threadId}; native tools will be unavailable this session`,
    )
  } else if (bridge) {
    // The offered tool list is the first thing anyone asks for when an agent
    // "did not use" a native tool, and an ACP run records no toolset
    // fingerprint of its own (that is a native-loop spine line).
    console.info(
      `[acp-bridge] offering ${String(bridge.toolNames.length)} native tool(s) to thread ${opts.threadId}: ${bridge.toolNames.join(', ')}`,
    )
  }
  const config: AcpAgentSpawnConfig = {
    ...opts.config,
    ...(bridge ? { nativeBridge: { url: bridge.url, token: bridge.token } } : {}),
  }

  let open: OpenAcpSession
  try {
    open = await openAcpSession(config, { current: null }, opts.createTransport, resumeSessionId)
  } catch (err) {
    bridgeAbort.abort()
    await bridge?.close()
    throw err
  }
  resumeCandidates.delete(opts.threadId)

  let disposal: Promise<void> | null = null
  const entry: PooledAcpSession = {
    open,
    bridge,
    fingerprint,
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
  return { entry, fresh: !open.resumed }
}

/** Evict and tear down one thread's session (e.g. after a broken turn). */
export async function disposeAcpSession(
  threadId: string,
  options: { preserveForResume?: boolean } = {},
): Promise<boolean> {
  const entry = pool.get(threadId)
  if (!entry) {
    if (!options.preserveForResume) resumeCandidates.delete(threadId)
    return false
  }
  if (options.preserveForResume) {
    rememberResumeCandidate(threadId, entry)
  } else {
    resumeCandidates.delete(threadId)
  }
  pool.delete(threadId)
  await entry.dispose()
  return true
}

/** Tear down every pooled session (app shutdown). */
export async function disposeAllAcpSessions(): Promise<void> {
  const entries = [...pool.values()]
  pool.clear()
  resumeCandidates.clear()
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
