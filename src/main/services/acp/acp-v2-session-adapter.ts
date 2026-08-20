import {
  ContentBlock as ContentBlockGuards,
  SessionUpdate as SessionUpdateGuards,
  StateUpdate as StateUpdateGuards,
} from '@agentclientprotocol/sdk/experimental/v2'
import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2'
import type { StreamChunk } from '@shared/types'

/**
 * PROTOTYPE — translating ACP **v2** session updates into Copse's `StreamChunk`
 * stream, alongside the shipping v1 `sessionUpdateToStreamChunk`.
 *
 * The v1 adapter is a pure function: one update in, at most one chunk out. v2
 * cannot be that, and this module exists to show exactly why and what it costs.
 *
 * Three v2 changes force state:
 *
 *  1. **Whole-message upserts.** v1 streams `agent_message_chunk` deltas. v2 also
 *     sends `agent_message`, which REPLACES the content for its `messageId`. A
 *     stateless mapper cannot tell a replacement from an append, so it would
 *     duplicate the message every time the agent revised it.
 *  2. **A single `tool_call_update`.** v1's `tool_call` (announce) /
 *     `tool_call_update` (patch) split is gone; in v2 the first update for an id
 *     IS the announcement. Only a record of ids seen so far can tell them apart.
 *  3. **`state_update` carries the turn.** In v1 `session/prompt` resolving meant
 *     the turn was over. In v2 it resolves on *accept*, and the turn ends when
 *     `state_update` reports `idle` with a `stopReason`. That is a lifecycle
 *     signal, not a chunk, so it leaves through {@link V2Applied.stopReason}
 *     rather than the chunk list.
 *
 * The happy discovery is that Copse's chunk vocabulary already has the primitive
 * the upsert model needs: `text_replace` ("replace accumulated assistant text"),
 * added for a different reason entirely. Whole-message updates map onto it
 * exactly, so v2's biggest shape change costs no new wire type — which the
 * readiness doc's table did not anticipate.
 *
 * One SDK constraint the v1 adapter's shape does not survive: **the v2 union
 * does not narrow on its discriminant**. `switch (update.sessionUpdate)` —
 * exactly how `session-update-adapter.ts` reads v1 — compiles, but every field
 * of the narrowed member comes out `unknown` (reproducible on a bare `tsc
 * --strict`, so it is the published types, not our config). The SDK ships
 * generated guards for this: `SessionUpdate.isAgentMessageChunk(update)` narrows
 * properly. So v2 mapping is a guard chain, not a switch.
 *
 * Deliberately not handled, and left explicit rather than silently dropped:
 * permission subjects, terminals, `available_commands_update`,
 * `config_option_update`, `session_info_update`, and `plan_update` (v2 wraps the
 * entries in a `plan` object where v1 had them at the top level). Those are the
 * rest of the migration, not this spike.
 */

/**
 * The v2 entry point re-exports `StateUpdate` but NOT `StopReason` — it is only
 * reachable as `schema.StopReason` inside the SDK's own declarations. Derive it
 * from the union rather than reaching into `dist/`, so this keeps compiling if
 * the export list is fixed upstream.
 */
type V2StateUpdate = Extract<SessionUpdate, { sessionUpdate: 'state_update' }>
export type V2StopReason = Extract<V2StateUpdate, { state: 'idle' }>['stopReason']

/** What one v2 update produced. */
export interface V2Applied {
  /** Chunks to push into the thread's stream, in order. */
  chunks: StreamChunk[]
  /** Set only by the `idle` state update that ends a turn. */
  stopReason?: V2StopReason
}

const NOTHING: V2Applied = { chunks: [] }

export interface V2SessionAdapter {
  apply(update: SessionUpdate): V2Applied
}

/** Text accumulated for one `messageId`, in arrival order. */
interface MessageBuffer {
  id: string
  text: string
}

export function createV2SessionAdapter(): V2SessionAdapter {
  // Agent messages only. `user_message` is our own prompt echoed back for
  // replay; the thread already has it, so re-emitting would double it.
  const agentMessages: MessageBuffer[] = []
  const seenToolCalls = new Set<string>()

  const bufferFor = (id: string): MessageBuffer => {
    const existing = agentMessages.find((message) => message.id === id)
    if (existing) return existing
    const created: MessageBuffer = { id, text: '' }
    agentMessages.push(created)
    return created
  }

  /** Every agent message so far, concatenated — what `text_replace` expects. */
  const allAgentText = (): string => agentMessages.map((message) => message.text).join('')

  return {
    apply(update: SessionUpdate): V2Applied {
      if (SessionUpdateGuards.isAgentMessageChunk(update)) {
        const text = textOf(update.content)
        if (text === '') return NOTHING
        bufferFor(update.messageId).text += text
        // An append is a delta, so it stays a plain `text` chunk — the cheap
        // path, and the one that keeps streaming feeling incremental.
        return { chunks: [{ type: 'text', text }] }
      }

      if (SessionUpdateGuards.isAgentMessage(update)) {
        // A whole-message upsert. Rewriting one message rewrites the turn's
        // accumulated text, so the replacement covers every message so far.
        bufferFor(update.messageId).text = (update.content ?? []).map(textOf).join('')
        return { chunks: [{ type: 'text_replace', text: allAgentText() }] }
      }

      if (SessionUpdateGuards.isAgentThoughtChunk(update)) {
        const text = textOf(update.content)
        // Reasoning has no replace primitive, so a whole-thought upsert
        // (`agent_thought`) cannot be expressed without one — it falls through
        // to the drop at the end rather than being double-rendered.
        return text === '' ? NOTHING : { chunks: [{ type: 'reasoning', text }] }
      }

      if (SessionUpdateGuards.isToolCallUpdate(update)) {
        const first = !seenToolCalls.has(update.toolCallId)
        seenToolCalls.add(update.toolCallId)
        const name = typeof update.name === 'string' ? update.name : undefined
        const status = toolStatus(update.status)
        // In v2 the first update for an id IS the announcement — there is no
        // separate `tool_call`, so the adapter has to remember which ids it has
        // already opened a card for.
        if (first) {
          return {
            chunks: [
              {
                type: 'tool_call',
                toolCall: {
                  id: update.toolCallId,
                  name: name ?? update.toolCallId,
                  args: update.rawInput ?? {},
                },
              },
            ],
          }
        }
        return {
          chunks: [
            {
              type: 'tool_call_update',
              toolCallId: update.toolCallId,
              ...(name !== undefined ? { name } : {}),
              ...(update.rawInput !== undefined && update.rawInput !== null
                ? { args: update.rawInput }
                : {}),
              ...(status !== undefined ? { status } : {}),
            },
          ],
        }
      }

      if (SessionUpdateGuards.isStateUpdate(update)) {
        // `running` is the turn starting; only `idle` ends it. `requires_action`
        // has no v1 counterpart and is left for the permission work.
        if (StateUpdateGuards.isIdle(update)) {
          return { chunks: [], stopReason: update.stopReason }
        }
        return NOTHING
      }

      if (SessionUpdateGuards.isUsageUpdate(update)) {
        // Unchanged from v1: the agent reports its own context directly, so the
        // same live context-pressure chunk carries it.
        return {
          chunks: [
            {
              type: 'context_pressure',
              contextWindow: update.size,
              conversationBudget: update.size,
              conversationTokens: update.used,
              fillRatio: update.size > 0 ? update.used / update.size : 0,
              source: 'agent-reported',
            },
          ],
        }
      }

      return NOTHING
    },
  }
}

/** Text out of one v2 content block; '' for anything not textual. */
function textOf(content: ContentBlock): string {
  return ContentBlockGuards.isText(content) ? content.text : ''
}

function toolStatus(status: unknown): 'running' | 'done' | 'error' | undefined {
  if (status === 'in_progress' || status === 'pending') return 'running'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  return undefined
}
