import type { LLMMessage, Message } from '@shared/types'
import { rebuildAgentHistory } from './thread-fork.ts'

/**
 * Recovering provider history for a thread whose `agent-history.json` sidecar is
 * empty but whose transcript is not.
 *
 * The sidecar is committed once, when a run finishes (`AgentDispatcher.execute`).
 * A run that never finishes — the app quits, the process is killed, a provider
 * wedges until the turn is abandoned — therefore contributes nothing, while the
 * user's prompt and any streamed assistant turns are already in `events.jsonl`.
 * The next turn then loads an empty sidecar and starts with no context at all,
 * even though the transcript in front of the user is full of it.
 *
 * That gap is not theoretical: a thread that lost a 13-step turn this way came
 * back with an empty context, and the next "continue" was answered by picking an
 * unrelated task out of a workspace-wide store — the model had nothing else to
 * go on. `forkThreadHistory` already handles the same hole for forks by
 * rebuilding from the transcript; this is that recovery on the dispatch path.
 */

/**
 * The transcript as of the *start* of the turn being dispatched.
 *
 * At dispatch time the renderer has already appended the outgoing prompt to the
 * transcript, and `runAgent` appends its own (redacted) copy to whatever prior
 * history it is handed. Replaying the trailing user message would therefore show
 * the model the same prompt twice — guaranteed on a thread whose first run is
 * the one being recovered from, where the transcript is that one message. Drop
 * it: everything before it is history this turn should see, and the prompt
 * itself arrives through `userContent`.
 *
 * Earlier unanswered user turns are kept. They are prompts the user really did
 * send and the model really did (or should have) seen — in the failure this
 * recovers from, the lost question was exactly such a turn.
 */
export function transcriptBeforePendingTurn(messages: readonly Message[]): Message[] {
  const last = messages.at(-1)
  return last?.role === 'user' ? messages.slice(0, -1) : [...messages]
}

/**
 * Rebuild the provider history a dispatching turn should start from, given the
 * thread's visible transcript. Returns `[]` when there is nothing to recover, so
 * callers can treat "no sidecar and nothing to rebuild" as a genuinely fresh
 * thread.
 */
export function recoverAgentHistory(messages: readonly Message[]): LLMMessage[] {
  return rebuildAgentHistory(transcriptBeforePendingTurn(messages))
}
