import {
  ContentBlock as ContentBlockGuards,
  SessionUpdate as SessionUpdateGuards,
  StateUpdate as StateUpdateGuards,
  ToolCallContent as ToolCallContentGuards,
} from '@agentclientprotocol/sdk/experimental/v2'
import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk/experimental/v2'
import type {
  AcpContentBlock,
  AcpToolCallContent,
  StreamChunk,
  ToolResultImage,
} from '@shared/types'
import { isRecord } from '@shared/unknown-value.ts'

/**
 * PROTOTYPE — translating ACP **v2** session updates into Copse's `StreamChunk`
 * stream, alongside the shipping v1 `sessionUpdateToStreamChunks`.
 *
 * The v1 adapter is a stateless function. v2 cannot be that, and this module
 * exists to show exactly why and what it costs.
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
 * Copse's stream therefore has an explicit message-id replacement primitive:
 * `acp_content_replace`. Unlike the older turn-wide `text_replace`, it can
 * revise one earlier message or thought without collapsing adjacent messages,
 * and it retains non-text content blocks.
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

export function createV2SessionAdapter(): V2SessionAdapter {
  const seenToolCalls = new Set<string>()

  return {
    apply(update: SessionUpdate): V2Applied {
      if (SessionUpdateGuards.isAgentMessageChunk(update)) {
        const content = normalizeContentBlock(update.content)
        return content === null
          ? NOTHING
          : {
              chunks: [
                { type: 'acp_content', channel: 'message', messageId: update.messageId, content },
              ],
            }
      }

      if (SessionUpdateGuards.isAgentMessage(update)) {
        if (update.content === undefined) return NOTHING
        return {
          chunks: [
            {
              type: 'acp_content_replace',
              channel: 'message',
              messageId: update.messageId,
              content: normalizeContentBlocks(update.content ?? []),
            },
          ],
        }
      }

      if (SessionUpdateGuards.isAgentThoughtChunk(update)) {
        const content = normalizeContentBlock(update.content)
        return content === null
          ? NOTHING
          : {
              chunks: [
                { type: 'acp_content', channel: 'thought', messageId: update.messageId, content },
              ],
            }
      }

      if (SessionUpdateGuards.isAgentThought(update)) {
        if (update.content === undefined) return NOTHING
        return {
          chunks: [
            {
              type: 'acp_content_replace',
              channel: 'thought',
              messageId: update.messageId,
              content: normalizeContentBlocks(update.content ?? []),
            },
          ],
        }
      }

      if (SessionUpdateGuards.isToolCallUpdate(update)) {
        const first = !seenToolCalls.has(update.toolCallId)
        seenToolCalls.add(update.toolCallId)
        const patch = toolCallPatch(update)
        // In v2 the first update for an id IS the announcement — there is no
        // separate `tool_call`, so the adapter has to remember which ids it has
        // already opened a card for.
        if (first) {
          const chunks: StreamChunk[] = [
            {
              type: 'tool_call',
              toolCall: {
                id: update.toolCallId,
                name: patch.name ?? update.toolCallId,
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                args: update.rawInput ?? {},
                ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
              },
            },
          ]
          if (Object.keys(patch).length > 1 || patch.status !== undefined) {
            chunks.push({ type: 'tool_call_update', toolCallId: update.toolCallId, ...patch })
          }
          return { chunks }
        }
        return {
          chunks:
            Object.keys(patch).length === 0
              ? []
              : [{ type: 'tool_call_update', toolCallId: update.toolCallId, ...patch }],
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

function safeMimeType(value: string | null | undefined): string {
  return value && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream'
}

function dataUrl(mimeType: string | null | undefined, data: string): string {
  return `data:${safeMimeType(mimeType)};base64,${data}`
}

function normalizeContentBlock(content: ContentBlock): AcpContentBlock | null {
  if (ContentBlockGuards.isText(content)) return { type: 'text', text: content.text }
  if (ContentBlockGuards.isImage(content)) {
    const mimeType = safeMimeType(content.mimeType)
    return {
      type: 'image',
      dataUrl: dataUrl(mimeType, content.data),
      mimeType,
      ...(content.uri ? { uri: content.uri } : {}),
    }
  }
  if (ContentBlockGuards.isAudio(content)) {
    const mimeType = safeMimeType(content.mimeType)
    return { type: 'audio', dataUrl: dataUrl(mimeType, content.data), mimeType }
  }
  if (ContentBlockGuards.isResourceLink(content)) {
    return {
      type: 'resource_link',
      uri: content.uri,
      name: content.name,
      ...(content.title ? { title: content.title } : {}),
      ...(content.description ? { description: content.description } : {}),
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      ...(content.size !== undefined && content.size !== null ? { size: content.size } : {}),
    }
  }
  if (ContentBlockGuards.isResource(content)) {
    const resource = content.resource
    const unknownResource: unknown = resource
    if (!isRecord(unknownResource)) return null
    const text = unknownResource['text']
    if (typeof text === 'string') {
      return {
        type: 'resource',
        uri: resource.uri,
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        text,
      }
    }
    const blob = unknownResource['blob']
    if (typeof blob !== 'string') return null
    return {
      type: 'resource',
      uri: resource.uri,
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      dataUrl: dataUrl(resource.mimeType, blob),
    }
  }
  return null
}

function normalizeContentBlocks(content: readonly ContentBlock[]): AcpContentBlock[] {
  return content.flatMap((block) => {
    const normalized = normalizeContentBlock(block)
    return normalized === null ? [] : [normalized]
  })
}

function normalizeToolCallContent(content: readonly ToolCallContent[]): AcpToolCallContent[] {
  return content.flatMap((item): AcpToolCallContent[] => {
    if (ToolCallContentGuards.isContent(item)) {
      const normalized = normalizeContentBlock(item.content)
      return normalized === null ? [] : [{ type: 'content', content: normalized }]
    }
    if (ToolCallContentGuards.isTerminal(item)) {
      return [{ type: 'terminal', terminalId: item.terminalId }]
    }
    if (ToolCallContentGuards.isDiff(item)) {
      const text = item.patch?.text ?? JSON.stringify(item.changes)
      return [{ type: 'content', content: { type: 'text', text } }]
    }
    return []
  })
}

function contentResult(content: readonly AcpToolCallContent[]): {
  text: string | null
  images: ToolResultImage[]
} {
  const text = content
    .flatMap((item) =>
      item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [],
    )
    .join('\n')
  const images = content.flatMap((item): ToolResultImage[] =>
    item.type === 'content' && item.content.type === 'image'
      ? [{ kind: 'screenshot', dataUrl: item.content.dataUrl }]
      : [],
  )
  return { text: text === '' ? null : text, images }
}

function formatRawToolValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolCallPatch(
  update: ToolCallUpdate,
): Omit<Extract<StreamChunk, { type: 'tool_call_update' }>, 'type' | 'toolCallId'> {
  const name = typeof update.name === 'string' ? update.name : undefined
  const title = typeof update.title === 'string' ? update.title : undefined
  const status = toolStatus(update.status)
  const content =
    update.content !== undefined ? normalizeToolCallContent(update.content ?? []) : undefined
  const rendered = content === undefined ? undefined : contentResult(content)
  const result =
    update.rawOutput !== undefined && update.rawOutput !== null
      ? formatRawToolValue(update.rawOutput)
      : rendered?.text
  return {
    ...(name !== undefined ? { name, programmaticName: name } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(update.rawInput !== undefined && update.rawInput !== null ? { args: update.rawInput } : {}),
    ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(result !== undefined
      ? { result, ...(result !== null ? { resultFormat: 'markdown' } : {}) }
      : {}),
    ...(rendered !== undefined ? { images: rendered.images } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(update.locations !== undefined
      ? {
          locations: (update.locations ?? []).map((location) => ({
            path: location.path,
            ...(location.line !== undefined && location.line !== null
              ? { line: location.line }
              : {}),
          })),
        }
      : {}),
  }
}

function toolStatus(status: unknown): 'running' | 'done' | 'error' | undefined {
  if (status === 'in_progress' || status === 'pending' || status === null) return 'running'
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'cancelled') return 'error'
  return undefined
}
