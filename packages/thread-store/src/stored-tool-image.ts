/**
 * A large tool image a thread stored, standing in for its bytes in a folded
 * transcript until something needs them.
 *
 * Agents that generate or screenshot images return each one as a data URL of
 * several megabytes, and an ACP agent repeats it in the call's display content.
 * A thread with a hundred of them folded to over a gigabyte of image text, and
 * every whole-thread read held all of it: sending one to the window hung the
 * main process inside the IPC serializer, the window ran out of heap signing
 * its rows, and main itself ran out of heap folding the thread for several
 * readers at once. So a store read leaves each large tool image in `blobs/`
 * and puts this reference in its `dataUrl` (and in the ACP content block that
 * repeats it). The window reads an image when it is about to be shown, and the
 * store resolves every reference back to the image before it writes, so a
 * reference is never persisted.
 *
 * The reference names the thread, the spine ref and the sha256 the spine
 * recorded, which a read checks before it returns the image.
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
