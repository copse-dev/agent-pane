import type { ArchiveAttachmentRef } from '@shared/archive/archive-media.ts'
import { formatByteSize } from '@shared/file-bytes.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { getThreadMeta } from '../thread-store.ts'

/**
 * The archives a thread has ever had attached, read from its `meta.json`.
 *
 * Same two turn-level decisions as `thread-videos.ts`: whether to offer
 * `read_archive` at all, and — when it is offered — restating the paths in its
 * description. The thread record is the durable copy; the reference block in the
 * user's message says the same thing but can be trimmed out from under a long
 * conversation.
 */
export async function getThreadArchives(): Promise<ArchiveAttachmentRef[]> {
  const context = getThreadExecutionContext()
  if (!context) return []
  try {
    const meta = await getThreadMeta(context.projectId, context.threadId)
    return meta?.archives ?? []
  } catch {
    // A thread whose meta cannot be read simply has no known archives; the tool
    // being withheld is a better failure than a run that dies reading metadata.
    return []
  }
}

/** The line appended to the `read_archive` description naming what is attached. */
export function describeThreadArchives(archives: readonly ArchiveAttachmentRef[]): string {
  const lines = archives.map((a) => `- "${a.name}" (${formatByteSize(a.sizeBytes)}): ${a.path}`)
  return `\n\nArchives attached to this conversation:\n${lines.join('\n')}`
}

const READ_ARCHIVE_TOOL = 'read_archive'

/**
 * Decide whether this turn's toolset carries `read_archive`, and what it says.
 *
 * Withheld entirely on a thread that has never had an archive attached — the
 * same bargain `video_frames` strikes, since most threads never see a zip and
 * should not pay for the schema every turn. An agent that needs to open a zip
 * sitting in the repo still has `run_shell`.
 */
export function applyArchiveToolAvailability<T extends { name: string; description: string }>(
  tools: T[],
  archives: readonly ArchiveAttachmentRef[],
): T[] {
  if (archives.length === 0) return tools.filter((t) => t.name !== READ_ARCHIVE_TOOL)
  return tools.map((t) =>
    t.name === READ_ARCHIVE_TOOL
      ? { ...t, description: `${t.description}${describeThreadArchives(archives)}` }
      : t,
  )
}
