import type { Thread } from '@shared/types'

// JSONL: one JSON object per line — easy to stream, grep, and re-import; each
// assistant line carries full toolCalls (args + results) inline.
export function threadToJsonl(thread: Thread): string {
  const lines: string[] = []
  lines.push(
    JSON.stringify({
      type: 'thread',
      id: thread.id,
      title: thread.title,
      exportedAt: new Date().toISOString(),
      usage: thread.usage,
      contextTrims: thread.contextTrims,
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
        content: msg.content,
        toolCalls: msg.toolCalls,
        createdAt: msg.createdAt,
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
