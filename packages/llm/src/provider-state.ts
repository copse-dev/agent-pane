import type { LLMMessage, ProviderCompactionState } from './wire-types.ts'

/**
 * Opaque, provider-owned artefacts that ride in the provider-history projection
 * (`agent-history.json`) beside the neutral messages.
 *
 * The one kind today is OpenAI's server-side compaction item. It is an encrypted
 * summary of everything before it, meaningful only to the model family that wrote
 * it, so every adapter except the matching Responses provider must never see it.
 * Each adapter therefore strips these messages at its own boundary
 * ({@link withoutProviderState}); only `ResponsesProvider` opts in through
 * {@link compactionReplayStart}.
 *
 * The neutral messages the item summarises are deliberately kept in the
 * projection. They are what a provider switch, a rejected replay, or a cache miss
 * falls back to, and dropping them would turn a recoverable miss into lost context.
 */

/** Where a compaction item may be replayed: the exact model on the exact endpoint. */
export interface CompactionIdentity {
  model: string
  /** Empty for first-party OpenAI; the base URL for a compatible endpoint. */
  endpoint: string
}

export type ProviderStateMessage = Extract<LLMMessage, { role: 'provider_state' }>

export function compactionMatches(
  state: ProviderCompactionState,
  identity: CompactionIdentity,
): boolean {
  return state.model === identity.model && state.endpoint === identity.endpoint
}

/**
 * Index of the latest compaction message `identity` may replay, or -1. Everything
 * before it is summarised by the item and left out of the request.
 */
export function compactionReplayStart(
  messages: readonly LLMMessage[],
  identity: CompactionIdentity | undefined,
): number {
  if (identity === undefined) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'provider_state' && compactionMatches(message.state, identity)) return i
  }
  return -1
}

/**
 * The instructions replayed ahead of the compaction item at `anchor` (see
 * {@link compactionReplayStart}): the item stands in for the turns before it,
 * not for the instructions. Every `system` message stays. Developer steering is
 * injected per turn, persisted where it lands, and each turn's supersedes the
 * last, so keeping every copy would stack one stale snapshot per turn ahead of
 * the item at each compaction. Only the newest copy before the item survives,
 * and only when no steering already follows it (decision 22 in
 * docs/plans/hooks-and-feature-packs.md).
 */
export function instructionsAheadOfCompaction(
  messages: readonly LLMMessage[],
  anchor: number,
): LLMMessage[] {
  const ahead = messages.slice(0, anchor)
  const steeringFollows = messages.slice(anchor + 1).some((m) => m.role === 'developer')
  const newestSteering = steeringFollows ? -1 : ahead.map((m) => m.role).lastIndexOf('developer')
  return ahead.filter(
    (m, i) => m.role === 'system' || (m.role === 'developer' && i === newestSteering),
  )
}

/** A message a provider that does not own provider state can convert to its wire format. */
export type ConversationMessage = Exclude<LLMMessage, ProviderStateMessage>

/** The messages a provider that does not understand provider state should send. */
export function withoutProviderState(messages: readonly LLMMessage[]): ConversationMessage[] {
  const out: ConversationMessage[] = []
  for (const message of messages) {
    if (message.role !== 'provider_state') out.push(message)
  }
  return out
}
