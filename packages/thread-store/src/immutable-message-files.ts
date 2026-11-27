import { sha256Hex } from '@copse/std/sha256.ts'
import { idPathSegment, type ExplodedMessage } from './fold.ts'

/**
 * Stage a replacement message without overwriting a file the live spine still
 * references and the fold verifies strictly (a mismatch skips the whole
 * thread). Prose, reasoning, rich ACP blocks, image data and attachment
 * snapshots move to content-addressed names. Each nested subagent transcript
 * moves as a whole to `subagents/~rev-<sha256>/`, so the parent's spine write
 * switches every nested file at once (#4438). Top-level tool-call blobs keep
 * their names, because a mismatch there degrades only that tool card.
 *
 * Each name hashes the complete file, so unchanged content reuses one
 * immutable file when metadata is finalized again. A prose file's OKF header
 * carries the message id, so two messages never share a prose revision.
 * `~rev-` cannot collide with a message's own files: `idPathSegment` adds a
 * leading `~` only to an id that is not plain, and that escaped form is never
 * `rev-` followed by a digest.
 *
 * A subagent directory's digest covers the subagent id and every nested file's
 * path and contents, so an unchanged transcript reuses its directory and two
 * sessions never share one. The renamed directory no longer spells the id, so
 * its spine entry always carries `id`.
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
  const toolCalls = line.toolCalls.map((tc) => {
    if (!tc.subagent) return tc
    const prefix = tc.subagent.ref
    const nested = message.files
      .filter((file) => file.ref.startsWith(prefix))
      .map((file): [string, string] => [file.ref.slice(prefix.length), file.contents])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (!/^subagents\/[^/]+\/$/.test(prefix) || nested.length === 0) {
      throw new Error('Missing replacement subagent files')
    }
    const id = tc.subagent.id ?? prefix.slice('subagents/'.length, -1)
    const dir = `subagents/~rev-${sha256Hex(JSON.stringify([id, nested]))}/`
    for (const [rest] of nested) renamed.set(prefix + rest, dir + rest)
    return { ...tc, subagent: { ...tc.subagent, ref: dir, id } }
  })
  return {
    line: {
      ...line,
      toolCalls,
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
