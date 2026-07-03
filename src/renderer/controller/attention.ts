import type { AppStore } from '@shared/store/store.ts'

// Tracks which threads are waiting on the user while *not* focused, so the
// sidebar can flag them with an attention indicator (a bell) instead of the
// prompt hijacking whichever thread is on screen. Attention comes from more
// than one source — a pending shell/MCP approval and a pending `ask_user`
// question both block a background thread — so contributions are kept per
// source and the union is what the sidebar reads. Keeping the union here (not
// in a single dialog) means neither source clobbers the other's flags.

export type AttentionSource = 'approval' | 'ask'

const bySource = new Map<AttentionSource, Set<string>>()
let union = new Set<string>()

function recompute(): boolean {
  const next = new Set<string>()
  for (const set of bySource.values()) {
    for (const id of set) next.add(id)
  }
  // Cheap equality check so we only emit (and re-render the sidebar) on a real
  // change, not on every dialog queue mutation.
  if (next.size === union.size && [...next].every((id) => union.has(id))) return false
  union = next
  return true
}

/**
 * Replace the set of threads a given source considers to be awaiting attention.
 * Emits `attention_changed` only when the resulting union actually changes.
 */
export function setAttentionThreads(
  store: AppStore,
  source: AttentionSource,
  threadIds: Iterable<string>,
): void {
  bySource.set(source, new Set(threadIds))
  if (recompute()) store.emit('attention_changed')
}

/** True when the thread is awaiting user input from any source while unfocused. */
export function isThreadAwaitingAttention(threadId: string): boolean {
  return union.has(threadId)
}

/** All thread ids currently flagged for attention (test/debug helper). */
export function getAttentionThreadIds(): string[] {
  return [...union]
}

/** Reset all attention state (used by tests). */
export function resetAttention(): void {
  bySource.clear()
  union = new Set<string>()
}
