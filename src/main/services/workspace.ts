import { relative, resolve, sep, basename as _basename } from 'node:path'
import { storageGet, storageSet } from './storage.ts'

const WORKSPACE_KEY = 'workspaceRoot'

let workspaceRoot: string | null = (storageGet(WORKSPACE_KEY) as string | null | undefined) ?? null

export function getWorkspaceRoot(): string | null {
  return workspaceRoot
}

export function setWorkspaceRoot(root: string | null): void {
  workspaceRoot = root
  storageSet(WORKSPACE_KEY, root)
}

/** Test helper — set workspace root without touching persistent storage. */
export function setWorkspaceRootForTest(root: string | null): () => void {
  const prev = workspaceRoot
  workspaceRoot = root
  return () => {
    workspaceRoot = prev
  }
}

export function resolveWorkspacePath(path: string): string {
  if (!workspaceRoot) throw new Error('No workspace open. Use Open Folder first.')
  const absRoot = resolve(workspaceRoot)
  const absTarget = path.startsWith('/') ? resolve(path) : resolve(absRoot, path)
  const rel = relative(absRoot, absTarget)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`Path outside workspace: ${path}`)
  }
  return absTarget
}

export function toRelativePath(absPath: string): string {
  if (!workspaceRoot) return absPath
  const rel = relative(resolve(workspaceRoot), resolve(absPath))
  if (!rel) return '.'
  return rel
}
