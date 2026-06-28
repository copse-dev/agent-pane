import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { storageGet, storageSet } from './storage.ts'

const WORKSPACE_KEY = 'workspaceRoot'
const PROJECTS_KEY = 'projects'
const ACTIVE_PROJECT_KEY = 'activeProjectId'

let workspaceRoot: string | null = (storageGet(WORKSPACE_KEY) as string | null | undefined) ?? null

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

function isPathInsideRoot(resolved: string, absRoot: string): boolean {
  const rel = relative(absRoot, resolved)
  return rel === '' || (!rel.startsWith('..') && !rel.split(sep).includes('..'))
}

function resolveThroughExistingPrefix(absPath: string): string {
  let probe = absPath
  while (true) {
    if (existsSync(probe)) {
      const realProbe = realpathSync.native(probe)
      const suffix = relative(probe, absPath)
      return suffix ? resolve(realProbe, suffix) : realProbe
    }
    const parent = dirname(probe)
    if (parent === probe) return absPath
    probe = parent
  }
}

export function resolveWorkspacePath(path: string): string {
  if (!workspaceRoot) throw new Error('No workspace open. Use Open Folder first.')
  const absRoot = realpathSync.native(resolve(workspaceRoot))
  let relPath = path
  if (isAbsolute(path)) {
    const absInput = resolveThroughExistingPrefix(resolve(path))
    const fromRoot = relative(absRoot, absInput)
    if (!isPathInsideRoot(absInput, absRoot)) {
      throw new Error(
        `Path outside workspace: ${path}. File tools require paths relative to the workspace root.`,
      )
    }
    relPath = fromRoot === '' ? '.' : fromRoot
  }
  const absTarget = resolve(absRoot, relPath)

  if (!isPathInsideRoot(absTarget, absRoot)) {
    throw new Error(
      `Path outside workspace: ${path}. File tools require paths relative to the workspace root.`,
    )
  }

  const resolved = resolveThroughExistingPrefix(absTarget)
  if (!isPathInsideRoot(resolved, absRoot)) {
    throw new Error(
      `Path outside workspace: ${path}. File tools require paths relative to the workspace root.`,
    )
  }
  return resolved
}

/**
 * Guard a write/create target against symlink escape before any `fs.writeFile`/
 * `mkdir` follows it. `resolveWorkspacePath` realpaths only the *existing* prefix of
 * a path, so a symlink whose target does not yet exist (a dangling symlink) is
 * skipped by the `existsSync` walk and treated as a plain new file — a subsequent
 * write would then follow it outside the workspace root. A repo can ship such a
 * symlink (e.g. `deploy.conf -> ../../../.ssh/authorized_keys`) and the agent
 * editing that path would clobber a file outside the workspace.
 *
 * `lstat` (no-follow) every path segment from the root down and reject any symlink
 * whose target resolves outside the root. Symlinks pointing *inside* the workspace
 * are allowed, so legitimate in-repo symlink edits keep working. Call this at every
 * site that writes/creates through a resolved path; reads are unaffected (a dangling
 * read just fails with ENOENT, and an existing symlink to outside is already caught
 * by `resolveWorkspacePath`'s realpath check).
 */
export function assertWorkspaceWriteTarget(absPath: string): void {
  if (!workspaceRoot) throw new Error('No workspace open. Use Open Folder first.')
  const absRoot = realpathSync.native(resolve(workspaceRoot))
  const rel = relative(absRoot, absPath)
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`Path outside workspace: ${absPath}.`)
  }
  let current = absRoot
  for (const segment of rel.split(sep)) {
    current = resolve(current, segment)
    let info
    try {
      info = lstatSync(current)
    } catch {
      // Segment does not exist yet (the new file/dir being created), and anything
      // deeper can't exist under it — nothing left to follow.
      break
    }
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(current), readlinkSync(current))
      if (!isPathInsideRoot(resolveThroughExistingPrefix(target), absRoot)) {
        throw new Error(`Refusing to write through a symlink that escapes the workspace: ${rel}`)
      }
    }
  }
}

export function toRelativePath(absPath: string): string {
  if (!workspaceRoot) return absPath
  const rel = relative(resolve(workspaceRoot), resolve(absPath))
  if (!rel) return '.'
  return rel
}
