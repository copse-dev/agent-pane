import type { Thread } from '@shared/types'

export function threadHasExportableContent(thread: Thread | undefined): thread is Thread {
  return (thread?.messages.length ?? 0) > 0
}

/**
 * Map a model id (as keyed in `usage.byModel`) to a provider slug, mirroring the
 * conventions used elsewhere: built-in cloud ids are inferred from their prefix
 * and any `<slug>:<model>` id carries its provider slug explicitly.
 */
function providerFromModelId(modelId: string): string {
  const colon = modelId.indexOf(':')
  if (colon > 0) return modelId.slice(0, colon)
  if (modelId.startsWith('claude')) return 'anthropic'
  if (modelId.startsWith('gpt')) return 'openai'
  return 'unknown'
}

function providersFromUsage(usage: Thread['usage']): string[] {
  const models = usage.byModel ? Object.keys(usage.byModel) : []
  return [...new Set(models.map(providerFromModelId))]
}

/** JSONL export schema revision — bump when thread/message header fields change. */
export const THREAD_JSONL_EXPORT_VERSION = 6

/** Serialize a thread as the portable, self-contained JSONL export format. */
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
        ...(msg.toolSummary !== undefined ? { toolSummary: msg.toolSummary } : {}),
        ...(msg.model !== undefined ? { model: msg.model } : {}),
        ...(msg.requestedModel !== undefined ? { requestedModel: msg.requestedModel } : {}),
        ...(msg.parameters !== undefined ? { parameters: msg.parameters } : {}),
        ...(msg.turnOutcome !== undefined ? { turnOutcome: msg.turnOutcome } : {}),
        ...(msg.review !== undefined ? { review: msg.review } : {}),
        toolCalls: msg.toolCalls,
      }),
    )
  }
  return lines.join('\n') + '\n'
}
