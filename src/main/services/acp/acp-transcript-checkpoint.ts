import { createHash, type Hash } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { LLMMessage, UserContent } from '@copse/llm/wire-types.ts'

export interface AcpTranscriptCheckpoint {
  messageCount: number
  prefixHash: string
}

/**
 * A prefix's hash state: SHA-256 fed `[` and the JSON of `messages`, comma
 * separated, still open for more. Finishing a copy with `]` gives the hash of
 * `JSON.stringify(messages)`, the value checkpoints have always stored.
 */
interface PrefixHashState {
  messages: readonly LLMMessage[]
  hash: Hash
}

/**
 * Recent prefix states, newest first. A thread's history only grows between
 * turns, so the next check usually extends one of these by a message or two
 * instead of rehashing every message (tens of megabytes when the history holds
 * prompt images). Matching is by message identity: history messages are built
 * once and never edited in place, and an edit or reload makes new objects, so
 * an identical object always serializes to the bytes it was hashed with.
 */
const recentPrefixes: PrefixHashState[] = []
const MAX_RECENT_PREFIXES = 8
/** Serialized messages hashed between turns of the event loop. */
const HASH_SLICE_CHARS = 4 << 20

function sharesPrefix(messages: readonly LLMMessage[], prefix: readonly LLMMessage[]): boolean {
  if (prefix.length > messages.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] !== messages[index]) return false
  }
  return true
}

function longestKnownPrefix(messages: readonly LLMMessage[]): PrefixHashState | undefined {
  let best: PrefixHashState | undefined
  for (const state of recentPrefixes) {
    if (
      state.messages.length > (best?.messages.length ?? -1) &&
      sharesPrefix(messages, state.messages)
    ) {
      best = state
    }
  }
  return best
}

function rememberPrefix(state: PrefixHashState): void {
  const existing = recentPrefixes.findIndex(
    (known) =>
      known.messages.length === state.messages.length &&
      sharesPrefix(state.messages, known.messages),
  )
  if (existing >= 0) recentPrefixes.splice(existing, 1)
  recentPrefixes.unshift(state)
  recentPrefixes.length = Math.min(recentPrefixes.length, MAX_RECENT_PREFIXES)
}

/** Feed one message, comma first unless it opens the array. */
function feed(hash: Hash, message: LLMMessage, first: boolean): number {
  const json = JSON.stringify(message)
  hash.update(first ? json : `,${json}`)
  return json.length
}

/**
 * The open hash state of `messages`, resumed from the longest prefix already
 * hashed. Main runs between slices of new messages, so even a cold hash of a
 * large history never holds it for the whole transcript.
 */
async function prefixState(messages: readonly LLMMessage[]): Promise<Hash> {
  const snapshot = messages.slice()
  const known = longestKnownPrefix(snapshot)
  const hash = known ? known.hash.copy() : createHash('sha256').update('[')
  const start = known?.messages.length ?? 0
  let sinceYield = 0
  for (const [offset, message] of snapshot.slice(start).entries()) {
    sinceYield += feed(hash, message, start + offset === 0)
    if (sinceYield >= HASH_SLICE_CHARS) {
      sinceYield = 0
      await yieldToEventLoop()
    }
  }
  rememberPrefix({ messages: snapshot, hash: hash.copy() })
  return hash
}

function finish(hash: Hash): string {
  return hash.update(']').digest('hex')
}

/** SHA-256 of `JSON.stringify(messages)`, without building that string. */
async function transcriptHash(messages: readonly LLMMessage[]): Promise<string> {
  return finish(await prefixState(messages))
}

/** The prefix delivered to the agent, excluding its not-yet-generated answer. */
export async function checkpointAcpTranscript(
  priorMessages: readonly LLMMessage[],
  prompt: UserContent,
): Promise<AcpTranscriptCheckpoint> {
  // The prompt message is built here, so it never matches a later history's
  // own copy by identity: only the prior messages are worth remembering.
  const hash = await prefixState(priorMessages)
  feed(hash, { role: 'user', content: prompt }, priorMessages.length === 0)
  return { messageCount: priorMessages.length + 1, prefixHash: finish(hash) }
}

/** A checkpoint for history the agent already holds in full, such as an imported session's. */
export async function checkpointAcpHistory(
  delivered: readonly LLMMessage[],
): Promise<AcpTranscriptCheckpoint> {
  return { messageCount: delivered.length, prefixHash: await transcriptHash(delivered) }
}

/** Catch up another provider's turns without resending this agent's own answers. */
export async function unseenAcpTranscript(
  priorMessages: LLMMessage[],
  checkpoint: AcpTranscriptCheckpoint | undefined,
): Promise<LLMMessage[]> {
  if (
    !checkpoint ||
    priorMessages.length < checkpoint.messageCount ||
    (await transcriptHash(priorMessages.slice(0, checkpoint.messageCount))) !==
      checkpoint.prefixHash
  )
    return priorMessages
  const tail = priorMessages.slice(checkpoint.messageCount)
  const firstUnseenUser = tail.findIndex((message) => message.role === 'user')
  return firstUnseenUser < 0 ? [] : tail.slice(firstUnseenUser)
}
