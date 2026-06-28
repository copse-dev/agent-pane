import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  attachmentsRootFor,
  threadAttachmentsDir,
  sanitizeSegment,
} from './attachment-store-paths.ts'
import { setAttachmentsRoot } from './workspace.ts'

/**
 * Spill store for large prompt attachments. The full content is written to an
 * app-owned dir outside the workspace, and that dir is registered as a
 * read-only root so the read tools (`read_file`) — and the explore subagent —
 * can open it on demand instead of inlining megabytes into the prompt.
 *
 * Writing/cleanup happen here in the main process; the agent only ever *reads*
 * the spilled file via its absolute path.
 */

/** Hard ceiling on a single spilled attachment (defensive; the UI caps earlier). */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

const randomUUID = () => globalThis.crypto.randomUUID()

export interface PersistedAttachment {
  /** Absolute path the agent passes to read_file/explore. */
  path: string
  bytes: number
}

/**
 * Point the read-only attachments root at this workspace's spill dir. Idempotent;
 * call when a workspace becomes active so reads resolve even before the first spill.
 */
export function registerAttachmentsRoot(workspaceRoot: string): void {
  setAttachmentsRoot(attachmentsRootFor(workspaceRoot))
}

/**
 * Write `content` to the spill store and return its absolute path. The
 * attachments root is (re)registered so the just-written file is readable.
 */
export async function persistAttachment(
  workspaceRoot: string,
  threadId: string,
  name: string,
  content: string,
): Promise<PersistedAttachment> {
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large to store (${bytes} bytes, max ${MAX_ATTACHMENT_BYTES}).`)
  }
  const dir = threadAttachmentsDir(workspaceRoot, threadId)
  await mkdir(dir, { recursive: true })
  registerAttachmentsRoot(workspaceRoot)
  const file = join(dir, `${randomUUID()}-${sanitizeSegment(name)}`)
  await writeFile(file, content, 'utf-8')
  return { path: file, bytes }
}

/** Remove one thread's spilled attachments (best-effort). */
export async function sweepThreadAttachments(workspaceRoot: string, threadId: string): Promise<void> {
  await rm(threadAttachmentsDir(workspaceRoot, threadId), { recursive: true, force: true })
}

/**
 * Remove all spilled attachments for a workspace (best-effort). Called when a
 * workspace becomes active so stale spills from previous sessions cannot
 * accumulate, then the root is re-registered for the new session.
 */
export async function sweepWorkspaceAttachments(workspaceRoot: string): Promise<void> {
  await rm(attachmentsRootFor(workspaceRoot), { recursive: true, force: true })
  registerAttachmentsRoot(workspaceRoot)
}
