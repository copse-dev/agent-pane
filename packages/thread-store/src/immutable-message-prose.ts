import { createHash } from 'node:crypto'
import type { ExplodedMessage } from './fold.ts'

/** Stage replacement prose without overwriting bytes referenced by the live spine. */
export function withImmutableMessageProse(message: ExplodedMessage): ExplodedMessage {
  const refs = new Map<string, string>()
  for (const prose of [message.line.content, message.line.reasoning]) {
    if (!prose) continue
    const file = message.files.find((entry) => entry.ref === prose.ref)
    if (!file) throw new Error('Missing replacement prose file')
    // Include the complete OKF header as well as its body. Unchanged prose
    // reuses one immutable file even when tool/status metadata is finalized again.
    const digest = createHash('sha256').update(file.contents).digest('hex')
    refs.set(prose.ref, `messages/revision-${digest}.md`)
  }
  const contentRef = refs.get(message.line.content.ref)
  if (!contentRef) throw new Error('Missing replacement message revision')
  const reasoningRef = message.line.reasoning ? refs.get(message.line.reasoning.ref) : undefined
  return {
    line: {
      ...message.line,
      content: { ...message.line.content, ref: contentRef },
      ...(message.line.reasoning && reasoningRef
        ? { reasoning: { ...message.line.reasoning, ref: reasoningRef } }
        : {}),
    },
    files: message.files.map((file) => ({ ...file, ref: refs.get(file.ref) ?? file.ref })),
  }
}
