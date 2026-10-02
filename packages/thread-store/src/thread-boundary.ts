import type { Message, Thread, ThreadUsage, ToolCall } from './thread-types.ts'
import type { ThreadMeta } from './spine-schema.ts'
import { isRecord } from '@copse/std/unknown-value.ts'
import { isNonNull } from '@copse/std/nullish.ts'
import { repairLegacyAcpTotalInputTokens } from '@copse/llm/model-usage.ts'

/**
 * Raise legacy ACP `byModel` entries recorded with fresh-only input to their
 * cache total (see {@link repairLegacyAcpTotalInputTokens}), raising the
 * thread's `inputTokens` total by the same amount so it still sums its models.
 * Runs on every meta read; a repaired entry no longer matches, so it is applied
 * at most once per entry and persists with the thread's next save.
 */
function repairLegacyAcpThreadUsage(usage: ThreadUsage): ThreadUsage {
  if (!isRecord(usage.byModel)) return usage
  let added = 0
  const byModel = { ...usage.byModel }
  for (const [model, modelUsage] of Object.entries(byModel)) {
    if (!isRecord(modelUsage) || typeof modelUsage.inputTokens !== 'number') continue
    const repaired = repairLegacyAcpTotalInputTokens(model, modelUsage)
    if (repaired === modelUsage) continue
    added += repaired.inputTokens - modelUsage.inputTokens
    byModel[model] = repaired
  }
  return added > 0 ? { ...usage, inputTokens: usage.inputTokens + added, byModel } : usage
}

function parseUsage(value: unknown): ThreadUsage | null {
  if (
    !isRecord(value) ||
    typeof value['inputTokens'] !== 'number' ||
    typeof value['outputTokens'] !== 'number'
  ) {
    return null
  }
  return repairLegacyAcpThreadUsage({
    ...value,
    inputTokens: value['inputTokens'],
    outputTokens: value['outputTokens'],
  })
}

function parseToolCall(value: unknown): ToolCall | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['name'] !== 'string' ||
    (value['status'] !== 'running' && value['status'] !== 'done' && value['status'] !== 'error') ||
    (typeof value['result'] !== 'string' && value['result'] !== null)
  ) {
    return null
  }
  return {
    ...value,
    id: value['id'],
    name: value['name'],
    args: value['args'],
    status: value['status'],
    result: value['result'],
  }
}

/** Decode the required persisted fields while preserving optional forward-compatible data. */
export function parseMessageValue(value: unknown): Message | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    (value['role'] !== 'user' && value['role'] !== 'assistant' && value['role'] !== 'error') ||
    typeof value['content'] !== 'string' ||
    !Array.isArray(value['toolCalls']) ||
    typeof value['createdAt'] !== 'number'
  ) {
    return null
  }
  const toolCalls = value['toolCalls'].map(parseToolCall)
  if (toolCalls.some((toolCall) => toolCall === null)) return null
  return {
    ...value,
    id: value['id'],
    role: value['role'],
    content: value['content'],
    toolCalls: toolCalls.filter(isNonNull),
    createdAt: value['createdAt'],
  }
}

export function parseThreadMetaValue(value: unknown): ThreadMeta | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['title'] !== 'string' ||
    (value['status'] !== 'idle' && value['status'] !== 'running' && value['status'] !== 'error') ||
    (value['unreadAt'] !== undefined && typeof value['unreadAt'] !== 'number') ||
    typeof value['createdAt'] !== 'number' ||
    typeof value['updatedAt'] !== 'number'
  ) {
    return null
  }
  const usage = parseUsage(value['usage'])
  if (usage === null) return null
  return {
    ...value,
    id: value['id'],
    title: value['title'],
    status: value['status'],
    usage,
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
  }
}

export function parseThreadValue(value: unknown): Thread | null {
  if (!isRecord(value) || !Array.isArray(value['messages'])) return null
  const meta = parseThreadMetaValue(value)
  if (meta === null) return null
  const messages = value['messages'].map(parseMessageValue)
  if (messages.some((message) => message === null)) return null
  return {
    ...meta,
    messages: messages.filter(isNonNull),
  }
}
