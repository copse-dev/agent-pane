import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  MAX_VIDEO_BYTES,
  SUPPORTED_VIDEO_EXTENSIONS,
  type VideoAttachmentRef,
} from '@shared/video/video-media.ts'
import { fileExtension, formatByteSize } from '@shared/file-bytes.ts'
import { resolveWorkspacePath } from '../workspace.ts'
import { chatStoreRoot, threadBlobsDir } from '../thread-store.ts'

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

/**
 * Largest video played inline in the preview modal.
 *
 * Playback reads the whole file into the renderer as a blob, so this bounds
 * renderer memory rather than anything about the format. The chat limit is
 * {@link MAX_VIDEO_BYTES} (256 MB) because the frame extractor streams through
 * a hidden window and never holds the pixels; a preview would pin every byte in
 * the visible renderer for as long as the modal is open. Above this the chip
 * stays inert and offers the file on disk instead — a stalled 200 MB preview is
 * worse than no preview.
 */
export const MAX_INLINE_PLAYBACK_BYTES = 50 * 1024 * 1024

export interface VideoPlaybackData {
  /** Explicitly ArrayBuffer-backed so the renderer can hand it straight to Blob. */
  bytes: Uint8Array<ArrayBuffer>
  mimeType: string
}

/** MIME type for a container Chromium can play, keyed off the file extension. */
function playbackMimeType(path: string): string {
  switch (fileExtension(path)) {
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    case '.ogv':
      return 'video/ogg'
    default:
      return 'video/mp4'
  }
}

/**
 * Read an attached video back for playback in the preview modal.
 *
 * The path comes from the renderer, so it is untrusted, and this grants the
 * *renderer* read access where `video_frames` grants it to the agent — a
 * narrower-looking call with the same reach. It is therefore authorised against
 * exactly the two roots the agent's read tools already accept: the chat store
 * (where dropped videos are written) and the workspace (where a video dragged
 * from the file tree still lives). Anything else is refused, so this cannot
 * become a general "read any file" channel by way of the preview.
 */
export async function readVideoForPlayback(path: string): Promise<VideoPlaybackData> {
  const extension = fileExtension(path)
  if (!(SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error(`${path} is not a supported video.`)
  }

  const resolved = resolve(path)
  const insideChatStore = isInside(resolved, chatStoreRoot())
  const abs = insideChatStore ? resolved : await resolveWorkspacePath(path)

  const stat = statSync(abs)
  if (!stat.isFile()) throw new Error('That video is not a file.')
  if (stat.size > MAX_INLINE_PLAYBACK_BYTES) {
    throw new Error(
      `This video is ${formatByteSize(stat.size)}, over the ${formatByteSize(MAX_INLINE_PLAYBACK_BYTES)} preview limit. Open it from disk instead.`,
    )
  }
  return { bytes: new Uint8Array(readFileSync(abs)), mimeType: playbackMimeType(abs) }
}

/** Whether `candidate` sits inside `root`, with no `..` escape. */
function isInside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
