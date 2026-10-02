/**
 * Encrypted reasoning items to replay on later requests, keyed by the id of the
 * first tool call they preceded.
 *
 * `agent-service` builds a fresh provider per user turn, so a map owned by the
 * provider instance forgets every earlier turn's reasoning. The next request
 * then omits items the previous one carried, the serialized prefix diverges at
 * the first such item, and the whole earlier tool chain is re-prefilled instead
 * of read from OpenAI's prompt cache. Scoping the map to (model, thread) lets
 * the replay survive provider rebuilds.
 *
 * Memory only, by design: the blobs are opaque vendor ciphertext, `store: false`
 * is a privacy choice, and a prompt cache entry does not outlive a restart
 * anyway. Bounded so an idle process does not accumulate every thread it saw.
 */

export interface ReplayableReasoning {
  type: 'reasoning'
  id: string
  summary: []
  encrypted_content: string
}

const MAX_SCOPES = 32
const scopes = new Map<string, Map<string, ReplayableReasoning[]>>()

/**
 * The replay map for one thread on one model. Without a thread key there is
 * nothing stable to scope to, so the caller gets a private map — the previous
 * per-provider behavior. A model switch gets its own scope: ciphertext produced
 * by one model is not replayed to another.
 */
export function reasoningReplayFor(
  model: string,
  scopeKey: string | undefined,
): Map<string, ReplayableReasoning[]> {
  if (scopeKey === undefined || scopeKey === '') return new Map()
  const key = JSON.stringify([model, scopeKey])
  const existing = scopes.get(key)
  const map = existing ?? new Map<string, ReplayableReasoning[]>()
  // Re-insert so the Map's iteration order is recency order.
  scopes.delete(key)
  scopes.set(key, map)
  if (scopes.size > MAX_SCOPES) {
    const oldest = scopes.keys().next().value
    if (oldest !== undefined) scopes.delete(oldest)
  }
  return map
}

/** Test support: forget every retained scope. */
export function clearReasoningReplayForTests(): void {
  scopes.clear()
}
