import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_ARCHIVE_BYTES,
  SUPPORTED_ARCHIVE_EXTENSIONS,
  type ArchiveAttachmentRef,
} from '@shared/archive/archive-media.ts'
import { fileExtension, formatByteSize } from '@shared/file-bytes.ts'
import { resolveWorkspacePath } from '../workspace.ts'
import { threadBlobsDir } from '../thread-store.ts'

/**
 * Where an archive a user drops into the chat is kept — the thread's own
 * `blobs/media/` directory, for exactly the reasons a video goes there
 * (`video-attachment-store.ts`): durable, deleted with the thread, and already
 * inside the one root the agent's read tools accept without extra authority.
 *
 * The archive is stored, never inlined. `read_archive` unpacks it from here.
 */

const MEDIA_DIR = 'media'

/** Keep a stored name free of anything path-like; it comes from a renderer `File`. */
function sanitizeFileName(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
  return safe || 'archive.zip'
}

function assertSupported(name: string): void {
  if (!(SUPPORTED_ARCHIVE_EXTENSIONS as readonly string[]).includes(fileExtension(name))) {
    throw new Error(
      `${name} is not a supported archive (${SUPPORTED_ARCHIVE_EXTENSIONS.join(', ')}).`,
    )
  }
}

export interface NewArchiveAttachmentInput {
  name: string
  bytes: Uint8Array
}

/** Write a dropped archive into a thread's media directory and describe it. */
export function storeArchiveAttachment(
  projectId: string,
  threadId: string,
  input: NewArchiveAttachmentInput,
): ArchiveAttachmentRef {
  const name = sanitizeFileName(input.name)
  assertSupported(name)
  if (input.bytes.byteLength === 0) throw new Error(`${input.name} is empty.`)
  if (input.bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `${input.name} is ${formatByteSize(input.bytes.byteLength)} — over the ${formatByteSize(MAX_ARCHIVE_BYTES)} limit for chat archives.`,
    )
  }

  const dir = join(threadBlobsDir(projectId, threadId), MEDIA_DIR)
  mkdirSync(dir, { recursive: true })
  // The uuid prefix keeps two drops of `release.zip` from colliding while
  // leaving the original name legible in the path the model is given.
  const path = join(dir, `${randomUUID()}-${name}`)
  writeFileSync(path, input.bytes)
  return { path, name: input.name, sizeBytes: input.bytes.byteLength }
}

/**
 * Describe an archive already in the workspace (dragged in from the file tree)
 * so it can be attached without copying. The path still goes through the
 * workspace resolver — a renderer-supplied path is untrusted, and the agent must
 * only ever be pointed at files it is allowed to read anyway.
 */
export async function describeWorkspaceArchive(
  path: string,
  name: string,
): Promise<ArchiveAttachmentRef> {
  assertSupported(name)
  const abs = await resolveWorkspacePath(path)
  const stat = statSync(abs)
  if (!stat.isFile()) throw new Error(`${name} is not a file.`)
  if (stat.size === 0) throw new Error(`${name} is empty.`)
  if (stat.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `${name} is ${formatByteSize(stat.size)} — over the ${formatByteSize(MAX_ARCHIVE_BYTES)} limit for chat archives.`,
    )
  }
  return { path: abs, name, sizeBytes: stat.size }
}
