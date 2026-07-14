import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { storageGet, storageSet } from './storage/storage.ts'
import { getActivePathBackend } from './workspace-fs/get-path-backend.ts'
import type { PathBackend } from './workspace-fs/path-backend.ts'

const WORKSPACE_KEY = 'workspaceRoot'
const PROJECTS_KEY = 'projects'
const ACTIVE_PROJECT_KEY = 'activeProjectId'

let workspaceRoot: string | null = (storageGet(WORKSPACE_KEY) as string | null | undefined) ?? null

/** Roots the renderer may activate via `workspace:set` (dialog-opened or persisted projects). */
const allowedWorkspaceRoots = new Set<string>()

export interface WorkspaceProjectRef {
  path: string
  sshHost?: string
}

/** Normalize a remote POSIX workspace path for allowlist keys and storage. */
export function normalizeRemoteWorkspacePath(path: string): string {
  let p = path.trim()
  if (!p) return '/'
  if (!p.startsWith('/')) p = `/${p}`
  const trimmed = p.replace(/\/+$/, '')
  return trimmed || '/'
}

/** Allowlist key for `(sshHost ?? '', path)` dedup and guard checks. */
export function workspaceRootKey(path: string, sshHost?: string): string {
  const normalized = sshHost ? normalizeRemoteWorkspacePath(path) : path
  return `${sshHost ?? ''}\0${normalized}`
}

/**
 * macOS seatbelt (ASRT) confines spawned shell/git tools to the workspace, but
 * `fs:*` IPC handlers read/write via node:fs in the unsandboxed main process.
 * Containment: path checks in this module plus, on macOS when ASRT is active,
 * `sandbox-fs-client` routes `fs:*` IPC through a seatbelt-wrapped worker subprocess.
 */
export async function canonicalWorkspaceRoot(
  root: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<string> {
  const abs = resolve(root)
  if (!(await backend.exists(abs))) {
    throw new Error(`Workspace root does not exist: ${root}`)
  }
  const real = await backend.realpath(abs)
  const stat = await backend.stat(real)
  if (!stat.isDirectory()) {
    throw new Error(`Workspace root must be a directory: ${root}`)
  }
  return real
}

export async function seedAllowedWorkspaceRoots(
  projects: Iterable<WorkspaceProjectRef>,
): Promise<void> {
  for (const project of projects) {
    try {
      if (project.sshHost) {
        allowedWorkspaceRoots.add(workspaceRootKey(project.path, project.sshHost))
      } else {
        allowedWorkspaceRoots.add(workspaceRootKey(await canonicalWorkspaceRoot(project.path)))
      }
    } catch {
      // Ignore stale or missing persisted project paths.
    }
  }
}

/** Register a folder the user opened or saved as a project (canonical path). */
export async function registerAllowedWorkspaceRoot(
  root: string,
  sshHost?: string,
): Promise<string> {
  if (sshHost) {
    const normalized = normalizeRemoteWorkspacePath(root)
    allowedWorkspaceRoots.add(workspaceRootKey(normalized, sshHost))
    return normalized
  }
  const canonical = await canonicalWorkspaceRoot(root)
  allowedWorkspaceRoots.add(workspaceRootKey(canonical))
  return canonical
}

export async function assertAllowedWorkspaceRoot(root: string, sshHost?: string): Promise<string> {
  if (sshHost) {
    const normalized = normalizeRemoteWorkspacePath(root)
    if (!allowedWorkspaceRoots.has(workspaceRootKey(normalized, sshHost))) {
      throw new Error('Workspace root is not an allowed project folder')
    }
    return normalized
  }
  const canonical = await canonicalWorkspaceRoot(root)
  if (!allowedWorkspaceRoots.has(workspaceRootKey(canonical))) {
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

/**
 * Id of the active project (the `activeProjectId` the renderer persists and keys
 * the filesystem thread-store by), or null when none is set. Lets main-process
 * services that only carry a `threadId` (e.g. the remote-agent clients) locate
 * the thread's on-disk directory without a projectId being threaded through.
 */
export function getActiveProjectId(): string | null {
  const id = storageGet(ACTIVE_PROJECT_KEY)
  return typeof id === 'string' && id.length > 0 ? id : null
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

/** SSH host id (`sshWorkspaceHosts[].id`) for the active project, if any. */
export function getActiveProjectSshHost(): string | undefined {
  const activeProjectId = storageGet(ACTIVE_PROJECT_KEY)
  if (typeof activeProjectId !== 'string') return undefined

  const projects = storageGet(PROJECTS_KEY)
  if (!Array.isArray(projects)) return undefined

  for (const project of projects) {
    if (!project || typeof project !== 'object') continue
    const candidate = project as { id?: unknown; sshHost?: unknown }
    if (candidate.id === activeProjectId && typeof candidate.sshHost === 'string') {
      return candidate.sshHost
    }
  }
  return undefined
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

async function resolveThroughExistingPrefix(
  absPath: string,
  backend: PathBackend,
): Promise<string> {
  let probe = absPath
  for (;;) {
    if (await backend.exists(probe)) {
      const realProbe = await backend.realpath(probe)
      const suffix = relative(probe, absPath)
      return suffix ? resolve(realProbe, suffix) : realProbe
    }
    const parent = dirname(probe)
    if (parent === probe) return absPath
    probe = parent
  }
}

export async function resolveWorkspacePath(
  path: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<string> {
  if (!workspaceRoot) throw new Error('No workspace open. Use Open Folder first.')
  const absRoot = await backend.realpath(resolve(workspaceRoot))
  let relPath = path
  if (isAbsolute(path)) {
    const absInput = await resolveThroughExistingPrefix(resolve(path), backend)
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

  const resolved = await resolveThroughExistingPrefix(absTarget, backend)
  if (!isPathInsideRoot(resolved, absRoot)) {
    throw new Error(
      `Path outside workspace: ${path}. File tools require paths relative to the workspace root.`,
    )
  }
  return resolved
}

/**
 * Root of the filesystem-native chat store (issue #644), honoring the
 * `COPSE_WORKSPACE_DIR` override — mirrors `thread-store.ts` (a follow-up unifies
 * both under one `COPSE_DIR`). Kept separate from the workspace root: the store
 * is mounted **read-only** so the agent can explore past threads with the
 * existing file tools, never write to them.
 */
function chatStoreDir(): string {
  const override = process.env['COPSE_WORKSPACE_DIR']?.trim()
  return override && override.length > 0 ? override : join(homedir(), '.copse', 'workspace')
}

/** Sync chat-store root for seatbelt overlay assembly (overlay builder stays sync). */
export function getChatStoreRootSync(): string | null {
  const dir = chatStoreDir()
  if (!existsSync(dir)) return null
  try {
    return realpathSync.native(resolve(dir))
  } catch {
    return null
  }
}

/** Canonical (realpath'd) chat-store root, or null when it does not exist yet. */
export async function getChatStoreRoot(
  backend: PathBackend = getActivePathBackend(),
): Promise<string | null> {
  const dir = chatStoreDir()
  if (!(await backend.exists(dir))) return null
  try {
    return await backend.realpath(resolve(dir))
  } catch {
    return null
  }
}

/**
 * True when a resolved absolute path lives inside the chat store — used by the
 * read tools to route chat-store targets down their non-workspace-indexed path
 * (the workspace file-index/`toRelativePath` are workspace-only).
 */
export async function isInsideChatStore(
  absPath: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<boolean> {
  const root = await getChatStoreRoot(backend)
  if (!root) return false
  return isPathInsideRoot(await resolveThroughExistingPrefix(resolve(absPath), backend), root)
}

/**
 * Resolve a path a **read** tool may open: the workspace (relative, or absolute
 * inside it) or — read-only — the chat store. Chat-store access is absolute-only
 * (the `@`-thread steering preamble hands out absolute canonical paths). Symlink
 * discipline matches the workspace root: a symlink whose real target escapes the
 * chat-store root is rejected (the existing prefix is realpath'd before the
 * containment check). Writes never route through here — `resolveWorkspacePath` +
 * `assertWorkspaceWriteTarget` stay workspace-only, so every write tool rejects
 * the chat store by construction.
 */
export async function resolveReadablePath(
  path: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<string> {
  try {
    return await resolveWorkspacePath(path, backend)
  } catch (workspaceErr) {
    if (isAbsolute(path)) {
      const chatRoot = await getChatStoreRoot(backend)
      if (chatRoot) {
        const absInput = await resolveThroughExistingPrefix(resolve(path), backend)
        if (isPathInsideRoot(absInput, chatRoot)) return absInput
      }
    }
    if (workspaceErr instanceof Error && workspaceErr.message.startsWith('No workspace open')) {
      throw workspaceErr
    }
    throw new Error(
      `Path outside workspace or chat store: ${path}. Read tools accept workspace-relative paths or absolute paths inside the chat store (~/.copse/workspace).`,
      { cause: workspaceErr },
    )
  }
}

/**
 * Guard a write/create target against symlink escape before any `fs.writeFile`/
 * `mkdir` follows it. `resolveWorkspacePath` realpaths only the *existing* prefix of
 * a path, so a symlink whose target does not yet exist (a dangling symlink) is
 * skipped by the exists walk and treated as a plain new file — a subsequent
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
export async function assertWorkspaceWriteTarget(
  absPath: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<void> {
  if (!workspaceRoot) throw new Error('No workspace open. Use Open Folder first.')
  const absRoot = await backend.realpath(resolve(workspaceRoot))
  const rel = relative(absRoot, absPath)
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`Path outside workspace: ${absPath}.`)
  }
  let current = absRoot
  for (const segment of rel.split(sep)) {
    current = resolve(current, segment)
    let info
    try {
      info = await backend.lstat(current)
    } catch {
      // Segment does not exist yet (the new file/dir being created), and anything
      // deeper can't exist under it — nothing left to follow.
      break
    }
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(current), await backend.readlink(current))
      if (!isPathInsideRoot(await resolveThroughExistingPrefix(target, backend), absRoot)) {
        throw new Error(`Refusing to write through a symlink that escapes the workspace: ${rel}`)
      }
    }
  }
}

/**
 * Re-validate that an already-resolved absolute path still resolves (via its
 * real on-disk location) inside the current workspace root. Used to guard
 * against TOCTOU symlink swaps between a watch registration and a later read:
 * the path is re-resolved through its existing prefix at read time so a
 * component swapped to a symlink pointing outside the workspace is rejected.
 * Returns false (rather than throwing) so callers can silently skip the event.
 */
export async function isResolvedPathInsideWorkspace(
  absPath: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<boolean> {
  if (!workspaceRoot) return false
  try {
    const absRoot = await backend.realpath(resolve(workspaceRoot))
    const resolved = await resolveThroughExistingPrefix(resolve(absPath), backend)
    return isPathInsideRoot(resolved, absRoot)
  } catch {
    return false
  }
}

export async function toRelativePath(
  absPath: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<string> {
  if (!workspaceRoot) return absPath
  const base = resolve(workspaceRoot)
  const target = resolve(absPath)
  let rel = relative(base, target)
  // A realpath'd input (e.g. from `resolveWorkspacePath`) compared against a
  // non-canonical workspace root produces a spurious `../` escape where the
  // root is symlinked (macOS `/var` -> `/private/var`; an Open Folder path is
  // not canonicalized). Only then pay the realpath cost and re-derive through
  // the canonical forms; the common in-workspace case keeps the cheap result.
  if (rel.startsWith('..')) {
    try {
      const realTarget = await resolveThroughExistingPrefix(target, backend)
      const realRel = relative(await backend.realpath(base), realTarget)
      if (!realRel.startsWith('..')) rel = realRel
      // A chat-store file (#644): a `../…` workspace-relative path is unusable —
      // the read tools only accept absolute paths for the chat store — so hand
      // back the absolute canonical path (search_code / list_dir output).
      else if (await isInsideChatStore(realTarget, backend)) return realTarget
    } catch {
      // Workspace root missing on disk (e.g. mock tests); keep the raw result.
    }
  }
  return rel || '.'
}
