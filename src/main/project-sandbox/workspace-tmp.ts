import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { getActiveRunThread } from '../services/active-run-identity.ts'
import { copseWorkspaceDir, copseWorkspaceTmpDir } from '../services/storage/copse-paths.ts'
import { currentThreadExecutionContext } from '../services/thread-execution-context-store.ts'

/** The active thread's scratch; operations without a thread use a separate host leaf. */
export function workspaceTmpDir(
  threadId: string | null = currentThreadExecutionContext()?.threadId ?? getActiveRunThread(),
): string {
  const root = copseWorkspaceTmpDir()
  return assignedScratchDir(root, threadId)
}

function assignedScratchDir(root: string, threadId: string | null): string {
  return threadId === null
    ? join(root, 'host')
    : join(root, 'threads', createHash('sha256').update(threadId).digest('hex'))
}

/** Create private scratch and use the exact canonical spelling the sandbox grants. */
export function ensureWorkspaceTmpDir(
  threadId: string | null = currentThreadExecutionContext()?.threadId ?? getActiveRunThread(),
): string {
  // Only the configured store parent is trusted to define a canonical grant.
  // Never follow an agent-writable scratch leaf to choose an allowWrite root.
  const store = copseWorkspaceDir()
  try {
    mkdirSync(store, { recursive: true, mode: 0o700 })
  } catch {
    // Preserve best-effort setup on read-only profiles.
  }
  let canonicalStore: string
  try {
    canonicalStore = realpathSync.native(store)
  } catch {
    canonicalStore = resolve(store)
  }
  const root = join(canonicalStore, 'tmp')
  const dir = assignedScratchDir(root, threadId)
  const paths = threadId === null ? [root, dir] : [root, join(root, 'threads'), dir]
  for (const path of paths) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    } catch {
      // Preserve best-effort setup on a read-only profile; the OS sandbox
      // still decides whether a command can use the configured scratch.
    }
    let entry: Stats
    try {
      entry = lstatSync(path)
    } catch {
      continue
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Workspace scratch must be a directory, not a symlink: ${path}`)
    }
  }
  return dir
}
