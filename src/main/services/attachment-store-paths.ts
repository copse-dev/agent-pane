import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Pure path math for the large-attachment spill store. Kept free of fs/state so
 * the layout — and the sanitisation that keeps caller-supplied names from
 * escaping the store — can be unit tested in isolation.
 *
 * Layout: ~/.copse/workspaces/<workspaceId>/attachments/<threadId>/<file>
 * The per-workspace dir is keyed by a hash of the workspace's real path so two
 * checkouts that share a folder name ("myCheckout1") never collide.
 */

export const COPSE_HOME_DIR = '.copse'

export function workspaceId(workspaceRoot: string): string {
  return createHash('sha256').update(resolve(workspaceRoot)).digest('hex').slice(0, 16)
}

/** Root the read tools are allowed to open for this workspace's attachments. */
export function attachmentsRootFor(workspaceRoot: string): string {
  return join(homedir(), COPSE_HOME_DIR, 'workspaces', workspaceId(workspaceRoot), 'attachments')
}

export function threadAttachmentsDir(workspaceRoot: string, threadId: string): string {
  return join(attachmentsRootFor(workspaceRoot), sanitizeSegment(threadId))
}

/**
 * Reduce an arbitrary id or filename to a single safe path segment: basename
 * only, conservative charset, length-capped, never empty or a `.`/`..` segment.
 */
export function sanitizeSegment(name: string, fallback = 'attachment'): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  return cleaned
}
