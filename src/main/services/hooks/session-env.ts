// Session-scoped hook environment store (H4) — the host side of `sessionStart`
// env propagation.
//
// A `sessionStart` hook may return an `env` object (Cursor's output field); the
// vendor contract is that those variables are "available to all subsequent hook
// executions within that session" (https://cursor.com/docs/hooks). This module
// is that per-session store: the `sessionStart` fire site collects each hook's
// `env` here (keyed by the session id — the thread id / `conversation_id`), and
// the command-hook runner reads it back when spawning any later hook for the
// session, layering it onto the scrubbed child env (`hook-spawn.ts`).
//
// Fire-and-forget by nature (decision 3): `sessionStart` is not awaited, so a
// hook that spawns before the store is populated simply misses the vars — the
// same best-effort timing the vendor documents. Later spawns pick them up.
//
// Module layout (execution-guidance rule 4): a host-owned process-wide store
// (like the async dispatcher / halt targets); `packages/agent` never sees it.

/** Env vars set for each session, keyed by session id (thread / conversation id). */
const sessionEnvs = new Map<string, Record<string, string>>()

/**
 * Merge `env` into the session's stored environment (H4). Multiple
 * `sessionStart` hooks accumulate (last writer wins per key), matching how
 * later hooks see the union of everything prior sessionStart hooks exported.
 */
export function mergeSessionEnv(sessionId: string, env: Record<string, string>): void {
  if (!sessionId) return
  const current = sessionEnvs.get(sessionId)
  sessionEnvs.set(sessionId, current ? { ...current, ...env } : { ...env })
}

/**
 * The session's accumulated env, or undefined when none was set. The runner
 * passes this to {@link import('./hook-spawn.ts').spawnHookProcess} as the
 * `sessionEnv` overlay for every later hook it spawns in the session.
 */
export function getSessionEnv(sessionId: string): Record<string, string> | undefined {
  if (!sessionId) return undefined
  return sessionEnvs.get(sessionId)
}

/**
 * Drop a session's env. Called when a new session begins on the same thread
 * (the `sessionStart` fire site clears before re-collecting on the first turn)
 * so env from a prior conversation never leaks into a fresh one.
 */
export function clearSessionEnv(sessionId: string): void {
  sessionEnvs.delete(sessionId)
}

/** Test-only: drop all session env between cases. */
export function resetSessionEnvForTest(): void {
  sessionEnvs.clear()
}
