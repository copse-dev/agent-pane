/**
 * A tool image that a window reads back from the thread store one at a time,
 * instead of receiving it inside the transcript.
 *
 * Agents that generate or screenshot images return each one as a data URL of
 * several megabytes, and an ACP agent repeats it in the call's display content.
 * A thread with about a hundred of them folds to roughly 600 MB of image text.
 * Sending that transcript to the window in one IPC message hung the main process
 * inside the serializer, and the window that did receive it spent seconds
 * signing every row and ran out of heap. So when main sends a transcript to a
 * window, each image it read from the thread's own `blobs/` travels as this
 * reference instead, in the same `dataUrl` field. The window resolves it when
 * the image is about to be shown, and main resolves it again before anything
 * the window sends back is written, so a reference is never persisted.
 *
 * The reference names the thread, the spine ref and the sha256 the spine
 * recorded, which main checks before it returns the image.
 */

const STORED_TOOL_IMAGE_SCHEME = 'copse-stored-image:'
const SHA256_HEX = /^[0-9a-f]{64}$/

export interface StoredToolImageAddress {
  readonly projectId: string
  readonly threadId: string
  /** The spine ref of the image blob, `blobs/<name>.dataurl`. */
  readonly ref: string
  readonly sha256: string
}

/** The reference a window receives in place of a stored tool image's data URL. */
export function storedToolImageUrl(address: StoredToolImageAddress): string {
  const parts = [address.projectId, address.threadId, address.ref, address.sha256]
  return STORED_TOOL_IMAGE_SCHEME + parts.map((part) => encodeURIComponent(part)).join('/')
}

/** Whether a `dataUrl` field holds a stored-image reference rather than the image itself. */
export function isStoredToolImageUrl(value: string): boolean {
  return value.startsWith(STORED_TOOL_IMAGE_SCHEME)
}

/** The address a reference names, or null for anything that is not a well-formed one. */
export function parseStoredToolImageUrl(value: string): StoredToolImageAddress | null {
  if (!isStoredToolImageUrl(value)) return null
  const parts = value.slice(STORED_TOOL_IMAGE_SCHEME.length).split('/')
  if (parts.length !== 4) return null
  let decoded: string[]
  try {
    decoded = parts.map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
  const [projectId, threadId, ref, sha256] = decoded
  if (!projectId || !threadId || !ref || sha256 === undefined || !SHA256_HEX.test(sha256)) {
    return null
  }
  return { projectId, threadId, ref, sha256 }
}
