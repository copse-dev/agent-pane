import type { AcpAgentSpawnConfig, AcpTransportFactory, OpenAcpSession } from './acp-client.ts'
import { openAcpSession } from './acp-client.ts'
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
 * - After a dropped connection, agents that advertise `session/resume` restore
 *   the same session on the replacement transport. If resuming is unavailable
 *   or rejected, a config change, or idle reaping forces a new session and the
 *   caller replays history once.
 * - Sessions idle longer than {@link IDLE_MS} are reaped, and everything is
 *   disposed at app shutdown.
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
  dispose: () => void
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
 * `model` is deliberately excluded — it switches live via set_config_option. */
export function acpSessionFingerprint(config: AcpAgentSpawnConfig): string {
  return JSON.stringify({
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    cwd: config.cwd,
    sandbox: config.sandbox ?? null,
    mcpServers: config.mcpServers ?? [],
  })
}

function ensureReaper(): void {
  if (reaper) return
  reaper = setInterval(() => {
    reapIdleAcpSessions()
  }, REAP_INTERVAL_MS)
  reaper.unref()
}

/** Evict sessions idle past `idleMs`. Exported with injectable `now` for tests. */
export function reapIdleAcpSessions(now = Date.now(), idleMs = IDLE_MS): string[] {
  const reaped: string[] = []
  for (const [threadId, entry] of pool) {
    if (now - entry.lastUsedAt >= idleMs) {
      entry.dispose()
      pool.delete(threadId)
      resumeCandidates.delete(threadId)
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
    existing.dispose()
    pool.delete(opts.threadId)
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
  const bridge = opts.registry
    ? await startAcpNativeBridge(opts.registry, bridgeAbort.signal).catch(() => null)
    : null
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

  const entry: PooledAcpSession = {
    open,
    bridge,
    fingerprint,
    lastUsedAt: Date.now(),
    dispose: () => {
      open.dispose()
      bridgeAbort.abort()
      if (bridge) void bridge.close()
    },
  }
  pool.set(opts.threadId, entry)
  return { entry, fresh: !open.resumed }
}

/** Evict and tear down one thread's session (e.g. after a broken turn). */
export function disposeAcpSession(
  threadId: string,
  options: { preserveForResume?: boolean } = {},
): void {
  const entry = pool.get(threadId)
  if (!entry) {
    if (!options.preserveForResume) resumeCandidates.delete(threadId)
    return
  }
  if (options.preserveForResume && entry.open.canResume) {
    resumeCandidates.set(threadId, {
      fingerprint: entry.fingerprint,
      sessionId: entry.open.session.sessionId,
    })
  } else {
    resumeCandidates.delete(threadId)
  }
  entry.dispose()
  pool.delete(threadId)
}

/** Tear down every pooled session (app shutdown). */
export function disposeAllAcpSessions(): void {
  for (const entry of pool.values()) entry.dispose()
  pool.clear()
  resumeCandidates.clear()
  if (reaper) {
    clearInterval(reaper)
    reaper = null
  }
}

/** Test/introspection helper. */
export function acpSessionPoolSize(): number {
  return pool.size
}
