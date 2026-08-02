import type { VideoAttachmentRef } from '@shared/video/video-media.ts'
import { formatByteSize } from '@shared/file-bytes.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { getThreadMeta } from '../thread-store.ts'

/**
 * The videos a thread has ever had attached, read from its `meta.json`.
 *
 * Two turn-level decisions hang off this (see `parentTools`): whether to offer
 * `video_frames` at all, and — when it is offered — restating the paths in its
 * description. The thread record is the durable copy; the reference block in the
 * user's message says the same thing but can be trimmed out from under a long
 * conversation.
 *
 * Returns `[]` outside an agent turn or when the thread has no record, which is
 * the common case: most threads never see a video and never pay for the tool.
 */
export async function getThreadVideos(): Promise<VideoAttachmentRef[]> {
  const context = getThreadExecutionContext()
  if (!context) return []
  try {
    const meta = await getThreadMeta(context.projectId, context.threadId)
    return meta?.videos ?? []
  } catch {
    // A thread whose meta cannot be read simply has no known videos; the tool
    // being withheld is a better failure than a run that dies reading metadata.
    return []
  }
}

/**
 * The line appended to the `video_frames` description naming what is attached.
 * Paths, not just names: this is what the model passes as `path`, and it is the
 * one copy guaranteed to be in front of it on every turn.
 */
export function describeThreadVideos(videos: readonly VideoAttachmentRef[]): string {
  const lines = videos.map((v) => `- "${v.name}" (${formatByteSize(v.sizeBytes)}): ${v.path}`)
  return `\n\nVideos attached to this conversation:\n${lines.join('\n')}`
}

/**
 * Decide whether this turn's toolset carries `video_frames`, and what it says.
 *
 * Withheld entirely on a thread that has never had a video — most threads, and
 * the schema costs ~480 tokens every turn it is offered. On a thread that has,
 * the attached paths are folded into the description so the model can always
 * name one, even if the message that introduced it has been trimmed away.
 */
export function applyVideoToolAvailability<T extends { name: string; description: string }>(
  tools: T[],
  videos: readonly VideoAttachmentRef[],
): T[] {
  if (videos.length === 0) return tools.filter((t) => t.name !== VIDEO_FRAMES_TOOL)
  return tools.map((t) =>
    t.name === VIDEO_FRAMES_TOOL
      ? { ...t, description: `${t.description}${describeThreadVideos(videos)}` }
      : t,
  )
}

const VIDEO_FRAMES_TOOL = 'video_frames'
