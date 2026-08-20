import type { Message, Thread, ThreadUsage, ToolCall } from '@shared/types'
import type { ThreadMeta } from './spine-schema.ts'
import { isRecord } from '@shared/unknown-value.ts'

function parseUsage(value: unknown): ThreadUsage | null {
  if (
    !isRecord(value) ||
    typeof value['inputTokens'] !== 'number' ||
    typeof value['outputTokens'] !== 'number'
  ) {
    return null
  }
  return {
    ...value,
    inputTokens: value['inputTokens'],
    outputTokens: value['outputTokens'],
  }
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
    toolCalls: toolCalls.filter((toolCall): toolCall is ToolCall => toolCall !== null),
    createdAt: value['createdAt'],
  }
}

export function parseThreadMetaValue(value: unknown): ThreadMeta | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['title'] !== 'string' ||
    (value['status'] !== 'idle' && value['status'] !== 'running' && value['status'] !== 'error') ||
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
    messages: messages.filter((message): message is Message => message !== null),
  }
}
