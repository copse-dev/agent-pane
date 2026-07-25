import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_VIDEO_BYTES,
  SUPPORTED_VIDEO_EXTENSIONS,
  fileExtension,
  formatByteSize,
  type VideoAttachmentRef,
} from '@shared/video/video-media.ts'
import { resolveWorkspacePath } from '../workspace.ts'
import { threadBlobsDir } from '../thread-store.ts'

/**
 * Where a video a user drops into the chat is kept.
 *
 * It goes in the thread's own `blobs/media/` directory rather than a temp dir or
 * the workspace: the thread store is already the durable home for a
 * conversation's content, it survives restarts, it is deleted with the thread,
 * and the agent's read tools already accept absolute paths inside it — so
 * `video_frames` can open the file without any new path authority. Crucially the
 * video is never turned into model content; only its path is.
 */

const MEDIA_DIR = 'media'

/**
 * Keep a stored name free of anything path-like. The name comes from a
 * renderer-supplied `File`, so it is untrusted input on the way to a filesystem
 * path even though the directory itself is ours.
 */
function sanitizeFileName(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
  return safe || 'video'
}

export interface NewVideoAttachmentInput {
  name: string
  mimeType: string
  bytes: Uint8Array
}

/**
 * Write a dropped video into a thread's media directory and describe it.
 * Throws (surfacing to the composer as a toast) rather than storing something
 * the frame extractor could not read back.
 */
export function storeVideoAttachment(
  projectId: string,
  threadId: string,
  input: NewVideoAttachmentInput,
): VideoAttachmentRef {
  const name = sanitizeFileName(input.name)
  const extension = fileExtension(name)
  if (!(SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error(
      `${input.name} is not a supported video (${SUPPORTED_VIDEO_EXTENSIONS.join(', ')}).`,
    )
  }
  if (input.bytes.byteLength === 0) throw new Error(`${input.name} is empty.`)
  if (input.bytes.byteLength > MAX_VIDEO_BYTES) {
    throw new Error(
      `${input.name} is ${formatByteSize(input.bytes.byteLength)} — over the ${formatByteSize(MAX_VIDEO_BYTES)} limit for chat videos.`,
    )
  }

  const dir = join(threadBlobsDir(projectId, threadId), MEDIA_DIR)
  mkdirSync(dir, { recursive: true })
  // The uuid prefix keeps two drops of `Screen Recording.mov` from colliding
  // while leaving the original name legible in the path the model is given.
  const path = join(dir, `${randomUUID()}-${name}`)
  writeFileSync(path, input.bytes)
  return {
    path,
    name: input.name,
    sizeBytes: input.bytes.byteLength,
    mimeType: input.mimeType,
  }
}

/**
 * Describe a video that is already in the workspace (dragged in from the file
 * tree) so it can be attached without copying. The path still goes through the
 * workspace resolver — a renderer-supplied path is untrusted, and the agent must
 * only ever be pointed at files it is allowed to read anyway.
 */
export async function describeWorkspaceVideo(
  path: string,
  name: string,
  mimeType: string,
): Promise<VideoAttachmentRef> {
  const extension = fileExtension(name)
  if (!(SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error(`${name} is not a supported video (${SUPPORTED_VIDEO_EXTENSIONS.join(', ')}).`)
  }
  const abs = await resolveWorkspacePath(path)
  const stat = statSync(abs)
  if (!stat.isFile()) throw new Error(`${name} is not a file.`)
  if (stat.size === 0) throw new Error(`${name} is empty.`)
  if (stat.size > MAX_VIDEO_BYTES) {
    throw new Error(
      `${name} is ${formatByteSize(stat.size)} — over the ${formatByteSize(MAX_VIDEO_BYTES)} limit for chat videos.`,
    )
  }
  return { path: abs, name, sizeBytes: stat.size, mimeType }
}
