/**
 * References a thread keeps to media stored beside it. Both point at the stored
 * copy inside the thread's `blobs/` directory; the media handling (decoding,
 * size caps, MIME sniffing) lives with the app, which imports these types back.
 */
export interface VideoAttachmentRef {
  /** Absolute path of the stored copy, inside the thread's blobs directory. */
  path: string
  /** Original file name, shown on the composer chip and in the prompt note. */
  name: string
  sizeBytes: number
  mimeType: string
}

export interface ArchiveAttachmentRef {
  /** Absolute path of the stored copy, inside the thread's blobs directory. */
  path: string
  /** Original file name, shown on the composer chip and in the prompt note. */
  name: string
  sizeBytes: number
}
