import { sha256Hex } from '@copse/std/sha256.ts'
import { idPathSegment, type ExplodedMessage } from './fold.ts'

/**
 * Stage a replacement message without overwriting a top-level file the live
 * spine still references. Every top-level file the fold verifies strictly (a
 * mismatch skips the whole thread) moves to a content-addressed name: prose,
 * reasoning, rich ACP blocks, image data and attachment snapshots. Tool-call
 * blobs keep their names, because a mismatch there degrades only that tool
 * card. A nested subagent transcript under `subagents/<id>/` is not covered and
 * is still rewritten in place (#4438).
 *
 * Each name hashes the complete file, so unchanged content reuses one
 * immutable file when metadata is finalized again. A prose file's OKF header
 * carries the message id, so two messages never share a prose revision.
 * `~rev-` cannot collide with a message's own files: `idPathSegment` adds a
 * leading `~` only to an id that is not plain, and that escaped form is never
 * `rev-` followed by a digest.
 */
export function withImmutableMessageFiles(message: ExplodedMessage): ExplodedMessage {
  const segment = idPathSegment(message.line.id)
  const contents = new Map(message.files.map((file) => [file.ref, file.contents]))
  const renamed = new Map<string, string>()
  const revision = <T extends { ref: string }>(entry: T): T => {
    const body = contents.get(entry.ref)
    const slash = entry.ref.indexOf('/')
    const name = entry.ref.slice(slash + 1)
    if (body === undefined || slash < 0 || !name.startsWith(segment)) {
      throw new Error('Missing replacement message file')
    }
    const ref = `${entry.ref.slice(0, slash)}/~rev-${sha256Hex(body)}${name.slice(segment.length)}`
    renamed.set(entry.ref, ref)
    return { ...entry, ref }
  }
  const { line } = message
  return {
    line: {
      ...line,
      content: revision(line.content),
      ...(line.reasoning ? { reasoning: revision(line.reasoning) } : {}),
      ...(line.contentBlocks ? { contentBlocks: revision(line.contentBlocks) } : {}),
      ...(line.reasoningBlocks ? { reasoningBlocks: revision(line.reasoningBlocks) } : {}),
      ...(line.images ? { images: line.images.map(revision) } : {}),
      ...(line.attachments
        ? {
            attachments: line.attachments.map((attachment) =>
              attachment.content
                ? { ...attachment, content: revision(attachment.content) }
                : attachment,
            ),
          }
        : {}),
    },
    files: message.files.map((file) => ({ ...file, ref: renamed.get(file.ref) ?? file.ref })),
  }
}
