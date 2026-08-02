import { fileExtension } from '../file-bytes.ts'

/**
 * Archive attachment vocabulary shared by the renderer (composer drops), the
 * main process (blob storage, the `read_archive` tool) and the extractor.
 *
 * An archive never enters the model's context as bytes. Like a video, the file
 * is stored next to the thread and the model is given a path; unlike a video,
 * what it does with that path is unpack it into the thread's own directory and
 * then read the result with the ordinary file tools. So the model does end up
 * seeing the contents — just the parts it chooses, as files, rather than a
 * megabyte of binary inlined into a prompt.
 */

/** What the reader in `zip-reader.ts` can open. Tar and friends are not supported. */
export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip'] as const

/**
 * Cap on a stored archive.
 *
 * Smaller than the video limit on purpose: the risk here is not the file but
 * what it expands to, and the extractor's own byte and ratio caps
 * (`archive-extract.ts`) are what actually bound that. This is simply the point
 * past which "attach a zip to a chat" stops being a reasonable thing to do.
 */
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024

export interface ArchiveAttachmentRef {
  /** Absolute path of the stored copy, inside the thread's blobs directory. */
  path: string
  /** Original file name, shown on the composer chip and in the prompt note. */
  name: string
  sizeBytes: number
}

/** MIME types browsers report for a zip; `.zip` files often arrive with none. */
const ARCHIVE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip',
])

/**
 * Whether a dropped/picked file should be treated as an archive attachment.
 *
 * Extension first here, unlike videos: zip MIME reporting is inconsistent across
 * platforms (`application/zip`, `application/x-zip-compressed`, or nothing at
 * all), while the `.zip` suffix is essentially universal.
 */
export function isArchiveFile(file: { name: string; type?: string }): boolean {
  if ((SUPPORTED_ARCHIVE_EXTENSIONS as readonly string[]).includes(fileExtension(file.name))) {
    return true
  }
  return file.type !== undefined && ARCHIVE_MIME_TYPES.has(file.type)
}
