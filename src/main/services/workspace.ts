import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { storageGet, storageSet } from './storage.ts'
import {
  isPathInsideRoot,
  resolveThroughExistingPrefix,
  resolveWithinRoot,
} from './path-containment.ts'

const WORKSPACE_KEY = 'workspaceRoot'
const PROJECTS_KEY = 'projects'
const ACTIVE_PROJECT_KEY = 'activeProjectId'

let workspaceRoot: string | null = (storageGet(WORKSPACE_KEY) as string | null | undefined) ?? null

/**
 * App-owned directory whose files the *read* tools may open in addition to the
 * workspace — the large-attachment spill store (`attachment-store.ts`). It is
 * read-only by construction: only `resolveReadablePath` consults it, never
 * `resolveWorkspacePath`, so writes/deletes/git/shell stay confined to the
 * workspace. Same real-path containment is applied, so a symlink inside the
 * store pointing elsewhere is still resolved-and-rejected.
 */
let attachmentsRoot: string | null = null

/** Roots the renderer may activate via `workspace:set` (dialog-opened or persisted projects). */
const allowedWorkspaceRoots = new Set<string>()

/**
 * macOS seatbelt (ASRT) confines spawned shell/git tools to the workspace, but
 * `fs:*` IPC handlers read/write via node:fs in the unsandboxed main process.
 * Containment: path checks in this module plus, on macOS when ASRT is active,
 * `sandbox-fs-client` routes `fs:*` IPC through a seatbelt-wrapped worker subprocess.
 */
export function canonicalWorkspaceRoot(root: string): string {
  const abs = resolve(root)
  if (!existsSync(abs)) {
    throw new Error(`Workspace root does not exist: ${root}`)
  }
  const real = realpathSync.native(abs)
  const stat = statSync(real)
  if (!stat.isDirectory()) {
    throw new Error(`Workspace root must be a directory: ${root}`)
  }
  return real
}

export function seedAllowedWorkspaceRoots(paths: Iterable<string>): void {
  for (const p of paths) {
    try {
      allowedWorkspaceRoots.add(canonicalWorkspaceRoot(p))
    } catch {
      // Ignore stale or missing persisted project paths.
    }
  }
}

/** Register a folder the user opened or saved as a project (canonical path). */
export function registerAllowedWorkspaceRoot(root: string): string {
  const canonical = canonicalWorkspaceRoot(root)
  allowedWorkspaceRoots.add(canonical)
  return canonical
}

export function assertAllowedWorkspaceRoot(root: string): string {
  const canonical = canonicalWorkspaceRoot(root)
  if (!allowedWorkspaceRoots.has(canonical)) {
    throw new Error('Workspace root is not an allowed project folder')
  }
  return canonical
}

/** @internal test helper */
export function clearAllowedWorkspaceRootsForTest(): void {
  allowedWorkspaceRoots.clear()
}

export function getWorkspaceRoot(): string | null {
  return workspaceRoot
}

export function getActiveProjectRoot(): string | null {
  const activeProjectId = storageGet(ACTIVE_PROJECT_KEY)
  if (typeof activeProjectId !== 'string') return workspaceRoot

  const projects = storageGet(PROJECTS_KEY)
  if (!Array.isArray(projects)) return workspaceRoot

  const activeProject = projects.find((project): project is { id: string; path: string } => {
    if (!project || typeof project !== 'object') return false
    const candidate = project as { id?: unknown; path?: unknown }
    return candidate.id === activeProjectId && typeof candidate.path === 'string'
  })

  return activeProject?.path ?? workspaceRoot
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

/** App-owned dir whose files the read tools may open (large-attachment store). */
export function setAttachmentsRoot(root: string | null): void {
  attachmentsRoot = root ? resolve(root) : null
}

export function getAttachmentsRoot(): string | null {
  return attachmentsRoot
}

function pathOutsideWorkspaceError(path: string): Error {
  return new Error(
    `Path outside workspace: ${path}. File tools require paths relative to the workspace root.`,
  )
}

export function resolveWorkspacePath(path: string): string {
  if (!workspaceRoot) throw new Error('No workspace open. Use Open Folder first.')
  const resolved = resolveWithinRoot(path, workspaceRoot)
  if (resolved === null) throw pathOutsideWorkspaceError(path)
  return resolved
}

/**
 * Like {@link resolveWorkspacePath} but also accepts absolute paths inside the
 * app-owned attachments root. Read-only: used solely by the read tools
 * (`read_file`) so the agent — and the explore subagent — can open large
 * attachments spilled outside the workspace, while writes/deletes remain
 * workspace-confined through `resolveWorkspacePath`.
 */
export function resolveReadablePath(path: string): string {
  if (workspaceRoot) {
    const inWorkspace = resolveWithinRoot(path, workspaceRoot)
    if (inWorkspace !== null) return inWorkspace
  }
  if (attachmentsRoot && isAbsolute(path)) {
    const inAttachments = resolveWithinRoot(path, attachmentsRoot)
    if (inAttachments !== null) return inAttachments
  }
  if (!workspaceRoot) throw new Error('No workspace open. Use Open Folder first.')
  throw pathOutsideWorkspaceError(path)
}

/**
 * Re-validate that an already-resolved absolute path still resolves (via its
 * real on-disk location) inside the current workspace root. Used to guard
 * against TOCTOU symlink swaps between a watch registration and a later read:
 * the path is re-resolved through its existing prefix at read time so a
 * component swapped to a symlink pointing outside the workspace is rejected.
 * Returns false (rather than throwing) so callers can silently skip the event.
 */
export function isResolvedPathInsideWorkspace(absPath: string): boolean {
  if (!workspaceRoot) return false
  try {
    const absRoot = realpathSync.native(resolve(workspaceRoot))
    const resolved = resolveThroughExistingPrefix(resolve(absPath))
    return isPathInsideRoot(resolved, absRoot)
  } catch {
    return false
  }
}

export function toRelativePath(absPath: string): string {
  if (!workspaceRoot) return absPath
  const rel = relative(resolve(workspaceRoot), resolve(absPath))
  if (!rel) return '.'
  return rel
}
