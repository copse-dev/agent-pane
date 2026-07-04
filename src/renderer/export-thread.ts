import type { Thread } from '@shared/types'

export function threadHasExportableContent(thread: Thread | undefined): thread is Thread {
  return (thread?.messages.length ?? 0) > 0
}

/**
 * Map a model id (as keyed in `usage.byModel`) to a provider slug, mirroring the
 * conventions used elsewhere: built-in cloud ids are inferred from their prefix
 * (`claude*` → anthropic, `gpt*` → openai) and any `<slug>:<model>` id carries
 * its provider slug explicitly (e.g. `lmstudio:qwen` → lmstudio).
 */
function providerFromModelId(modelId: string): string {
  const colon = modelId.indexOf(':')
  if (colon > 0) return modelId.slice(0, colon)
  if (modelId.startsWith('claude')) return 'anthropic'
  if (modelId.startsWith('gpt')) return 'openai'
  return 'unknown'
}

/** Distinct provider slugs inferred from the thread's per-model usage keys. */
function providersFromUsage(usage: Thread['usage']): string[] {
  const models = usage.byModel ? Object.keys(usage.byModel) : []
  return [...new Set(models.map(providerFromModelId))]
}

/** JSONL export schema revision — bump when thread/message header fields change. */
export const THREAD_JSONL_EXPORT_VERSION = 3

// JSONL: one JSON object per line — easy to stream, grep, and re-import. The
// message line uses the same field names as the on-disk spine
// (`@shared/threads/spine-schema.ts`, issue #644) — type/id/role/createdAt/
// content/reasoning/images/commandSummary/toolCalls — with one deliberate
// difference: an export stays single-file and self-contained, so it INLINES the
// values the spine stores as refs (message/reasoning prose, tool results, and
// full nested subagent sessions) instead of pointing at `messages/*.md`,
// `blobs/*`, or `subagents/**`.
export function threadToJsonl(thread: Thread): string {
  const lines: string[] = []
  lines.push(
    JSON.stringify({
      type: 'thread',
      exportVersion: THREAD_JSONL_EXPORT_VERSION,
      id: thread.id,
      title: thread.title,
      status: thread.status,
      exportedAt: new Date().toISOString(),
      usage: thread.usage,
      providers: providersFromUsage(thread.usage),
      contextTrims: thread.contextTrims,
      contextSnapshot: thread.contextSnapshot,
      todos: thread.todos,
      review: thread.review,
      workingBrief: thread.workingBrief,
      gitBranch: thread.gitBranch,
      pendingMessages: thread.pendingMessages,
      queuePaused: thread.queuePaused,
      draftPrompt: thread.draftPrompt,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }),
  )
  for (const msg of thread.messages) {
    // Field order mirrors the spine message line for greppability.
    lines.push(
      JSON.stringify({
        type: 'message',
        id: msg.id,
        role: msg.role,
        createdAt: msg.createdAt,
        content: msg.content,
        ...(msg.reasoning !== undefined ? { reasoning: msg.reasoning } : {}),
        images: msg.images,
        commandSummary: msg.commandSummary,
        toolCalls: msg.toolCalls,
      }),
    )
  }
  return lines.join('\n') + '\n'
}

export function downloadThreadJsonl(thread: Thread): void {
  const body = threadToJsonl(thread)
  const slug = thread.title.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'thread'
  const stamp = new Date().toISOString().slice(0, 10)
  const blob = new Blob([body], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug}-${stamp}.jsonl`
  a.click()
  URL.revokeObjectURL(url)
}
