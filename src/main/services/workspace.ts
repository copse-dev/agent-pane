import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chatStoreDir as copseChatStoreDir } from './storage/copse-paths.ts'
import { storageGet, storageSet } from './storage/storage.ts'
import { getActivePathBackend } from './workspace-fs/get-path-backend.ts'
import { localWorkspaceFs } from './workspace-fs/local-workspace-fs.ts'
import type { PathBackend } from './workspace-fs/path-backend.ts'
import { isRecord } from '@shared/unknown-value.ts'

const WORKSPACE_KEY = 'workspaceRoot'
const PROJECTS_KEY = 'projects'
const ACTIVE_PROJECT_KEY = 'activeProjectId'

const storedWorkspaceRoot = storageGet(WORKSPACE_KEY)
let workspaceRoot: string | null =
  typeof storedWorkspaceRoot === 'string' ? storedWorkspaceRoot : null

const explicitWorkspace = new AsyncLocalStorage<{ readonly root: string }>()

/** Scope workspace-dependent product services to an explicit headless run root. */
export function runWithWorkspaceRoot<T>(root: string, fn: () => T): T {
  return explicitWorkspace.run({ root }, fn)
}

/** Roots the renderer may activate via `workspace:set` (dialog-opened or persisted projects). */
const allowedWorkspaceRoots = new Set<string>()

/** Linked-worktree roots trusted by the main process, never renderer-selectable. */
export interface InternalWorkspaceRootRegistration {
  /** Effective thread root (which may be a project subdirectory of the checkout). */
  readonly root: string
  /** Top-level linked checkout containing the `.git` indirection file. */
  readonly checkoutRoot: string
  readonly gitDir: string
  readonly commonGitDir: string
  /**
   * Main-repository working tree derived from `commonGitDir` when its basename
   * is `.git` (the standard non-bare layout). `null` for bare repositories or
   * unusual `commondir` values where no primary checkout can be inferred. The
   * sandbox denies reads under this path so a linked-worktree agent cannot
   * read the shared project tree of an outside-$HOME layout (tmpdir,
   * `COPSE_WORKTREES_DIR`, …) where ASRT's default home-deny does not apply.
   */
  readonly primaryCheckoutRoot: string | null
  /** Other linked checkouts in the same repository, explicitly denied by the sandbox. */
  readonly siblingRoots: readonly string[]
}

const internalWorkspaceRoots = new Map<string, InternalWorkspaceRootRegistration>()

/** Resolves once persisted project roots are seeded at main-process startup. */
let allowedWorkspaceRootsReady: Promise<void> = Promise.resolve()

/**
 * Kick off async seeding of persisted project roots during handler registration.
 * `assertAllowedWorkspaceRoot` awaits this so an early `workspace:set` cannot
 * race the fire-and-forget bootstrap.
 */
export function scheduleAllowedWorkspaceRootsBootstrap(bootstrap: () => Promise<void>): void {
  allowedWorkspaceRootsReady = bootstrap()
}

async function awaitAllowedWorkspaceRootsReady(): Promise<void> {
  await allowedWorkspaceRootsReady
}

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
        // Local project roots always live on the Mac/host disk — never probe
        // them through an active SSH PathBackend (that would ask the remote
        // host whether `/Users/...` exists and silently drop the seed).
        allowedWorkspaceRoots.add(
          workspaceRootKey(await canonicalWorkspaceRoot(project.path, localWorkspaceFs)),
        )
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
  // Open Folder / Relocate always pick a local directory. Use the local FS
  // even when an SSH project is still the active execution target — otherwise
  // `getActivePathBackend()` would check the path on the remote host.
  const canonical = await canonicalWorkspaceRoot(root, localWorkspaceFs)
  allowedWorkspaceRoots.add(workspaceRootKey(canonical))
  return canonical
}

export async function assertAllowedWorkspaceRoot(root: string, sshHost?: string): Promise<string> {
  await awaitAllowedWorkspaceRootsReady()
  if (sshHost) {
    const normalized = normalizeRemoteWorkspacePath(root)
    if (!allowedWorkspaceRoots.has(workspaceRootKey(normalized, sshHost))) {
      throw new Error('Workspace root is not an allowed project folder')
    }
    return normalized
  }
  const canonical = await canonicalWorkspaceRoot(root, localWorkspaceFs)
  if (!allowedWorkspaceRoots.has(workspaceRootKey(canonical))) {
    throw new Error('Workspace root is not an allowed project folder')
  }
  return canonical
}

/**
 * Register a locally-created linked worktree without making it an openable project.
 *
 * The relationship is derived from Git's own administrative files and validated
 * narrowly: `.git` must point at one child of `<common>/.git/worktrees`, whose
 * `commondir` must point back to that common directory. The sandbox can then use
 * this trusted record without accepting an arbitrary renderer-supplied parent path.
 */
export async function registerInternalWorkspaceRoot(
  checkoutRoot: string,
  executionRoot: string = checkoutRoot,
): Promise<InternalWorkspaceRootRegistration> {
  const canonicalCheckoutRoot = await canonicalWorkspaceRoot(checkoutRoot)
  const canonicalExecutionRoot = await canonicalWorkspaceRoot(executionRoot)
  const executionRelative = relative(canonicalCheckoutRoot, canonicalExecutionRoot)
  if (executionRelative === '..' || executionRelative.startsWith(`..${sep}`)) {
    throw new Error('Internal execution root is outside its linked Git worktree')
  }
  const dotGitPath = join(canonicalCheckoutRoot, '.git')
  const dotGit = await readFile(dotGitPath, 'utf-8')
  const match = /^gitdir:\s*(.+?)\s*$/i.exec(dotGit.trim())
  if (!match?.[1]) throw new Error('Internal workspace root is not a linked Git worktree')

  const gitDir = realpathSync.native(resolve(canonicalCheckoutRoot, match[1]))
  const commonRelative = (await readFile(join(gitDir, 'commondir'), 'utf-8')).trim()
  if (!commonRelative) throw new Error('Linked worktree has no common Git directory')
  const commonGitDir = realpathSync.native(resolve(gitDir, commonRelative))
  if (dirname(gitDir) !== join(commonGitDir, 'worktrees')) {
    throw new Error('Linked worktree Git directory is outside the common worktrees directory')
  }

  const siblingRoots: string[] = []
  for (const entry of await readdir(dirname(gitDir), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === basename(gitDir)) continue
    try {
      const siblingGitFile = (
        await readFile(join(dirname(gitDir), entry.name, 'gitdir'), 'utf-8')
      ).trim()
      if (!siblingGitFile) continue
      const siblingDotGit = realpathSync.native(
        isAbsolute(siblingGitFile)
          ? siblingGitFile
          : resolve(dirname(gitDir), entry.name, siblingGitFile),
      )
      siblingRoots.push(dirname(siblingDotGit))
    } catch {
      // A stale/prunable sibling cannot grant authority; it needs no extra deny path.
    }
  }

  // Standard non-bare layout: `<primary>/.git` is the common Git directory, so
  // the primary working tree is its parent. Bare repos (or unusual custom
  // `commondir` targets) have no working tree — leave `primaryCheckoutRoot`
  // null and rely on the sibling deny list plus the home-deny fallback.
  const primaryCheckoutRoot = basename(commonGitDir) === '.git' ? dirname(commonGitDir) : null

  const registration: InternalWorkspaceRootRegistration = Object.freeze({
    root: canonicalExecutionRoot,
    checkoutRoot: canonicalCheckoutRoot,
    gitDir,
    commonGitDir,
    primaryCheckoutRoot,
    siblingRoots: Object.freeze([...new Set(siblingRoots)]),
  })
  internalWorkspaceRoots.set(canonicalExecutionRoot, registration)
  return registration
}

/** Return a previously validated internal root for sandbox construction. */
export function getInternalWorkspaceRootRegistration(
  root: string,
): InternalWorkspaceRootRegistration | null {
  let canonical = resolve(root)
  try {
    canonical = realpathSync.native(canonical)
  } catch {
    // Missing roots cannot acquire new authority; only an existing exact record can match.
  }
  return internalWorkspaceRoots.get(canonical) ?? null
}

export function unregisterInternalWorkspaceRoot(root: string): void {
  const registration = getInternalWorkspaceRootRegistration(root)
  if (registration) internalWorkspaceRoots.delete(registration.root)
}

/** @internal test helper */
export function clearAllowedWorkspaceRootsForTest(): void {
  allowedWorkspaceRoots.clear()
  internalWorkspaceRoots.clear()
  allowedWorkspaceRootsReady = Promise.resolve()
}

export function getWorkspaceRoot(): string | null {
  return explicitWorkspace.getStore()?.root ?? workspaceRoot
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

/** Resolve a persisted project's root without consulting renderer-selected workspace state. */
export function getProjectRoot(projectId: string): string | null {
  const projects = storageGet(PROJECTS_KEY)
  if (!Array.isArray(projects)) return null

  const project = projects.find((candidate): candidate is { id: string; path: string } => {
    return (
      isRecord(candidate) && candidate['id'] === projectId && typeof candidate['path'] === 'string'
    )
  })

  return project?.path ?? null
}

export function getActiveProjectRoot(): string | null {
  const currentRoot = getWorkspaceRoot()
  if (explicitWorkspace.getStore()) return currentRoot
  const activeProjectId = storageGet(ACTIVE_PROJECT_KEY)
  if (typeof activeProjectId !== 'string') return currentRoot
  return getProjectRoot(activeProjectId) ?? currentRoot
}

/** Resolve a persisted project's id/name/path (e.g. for the roadmap exporter's project metadata). */
export function getProjectById(
  projectId: string,
): { id: string; name: string; path: string } | null {
  const projects = storageGet(PROJECTS_KEY)
  if (!Array.isArray(projects)) return null

  const project = projects.find(
    (candidate): candidate is { id: string; name: string; path: string } =>
      isRecord(candidate) &&
      candidate['id'] === projectId &&
      typeof candidate['name'] === 'string' &&
      typeof candidate['path'] === 'string',
  )
  return project ?? null
}

/** SSH host id (`sshWorkspaceHosts[].id`) for the active project, if any. */
export function getActiveProjectSshHost(): string | undefined {
  const activeProjectId = storageGet(ACTIVE_PROJECT_KEY)
  if (typeof activeProjectId !== 'string') return undefined

  const projects = storageGet(PROJECTS_KEY)
  if (!Array.isArray(projects)) return undefined

  for (const project of projects) {
    if (!isRecord(project)) continue
    if (project['id'] === activeProjectId && typeof project['sshHost'] === 'string') {
      return project['sshHost']
    }
  }
  return undefined
}

/**
 * Resolve which SSH host owns a workspace root about to be activated.
 * Prefer an explicit host from the renderer, then any persisted project whose
 * path matches (so `workspace:set` never falls through to a local `exists`
 * check for remote roots like `/etc/ddg`).
 *
 * Do **not** inherit the active project's sshHost for an unrelated path —
 * switching from an SSH project to a local folder would otherwise treat the
 * local Mac path as remote and fail the allowlist check.
 */
export function resolveSshHostForWorkspaceRoot(
  root: string,
  explicitSshHost?: string,
): string | undefined {
  if (explicitSshHost) return explicitSshHost

  const projects = storageGet(PROJECTS_KEY)
  if (!Array.isArray(projects)) return undefined
  const normalized = normalizeRemoteWorkspacePath(root)
  for (const project of projects) {
    if (!isRecord(project)) continue
    const path = project['path']
    const sshHost = project['sshHost']
    if (typeof path !== 'string' || typeof sshHost !== 'string') continue
    if (normalizeRemoteWorkspacePath(path) === normalized) return sshHost
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
  const root = getWorkspaceRoot()
  if (!root) throw new Error('No workspace open. Use Open Folder first.')
  return resolvePathWithinRoot(path, root, backend)
}

/** Resolve a path against an explicit trusted root, with the workspace containment rules. */
export async function resolvePathWithinRoot(
  path: string,
  root: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<string> {
  const absRoot = await backend.realpath(resolve(root))
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
const chatStoreDir = copseChatStoreDir

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
  const root = getWorkspaceRoot()
  if (!root) throw new Error('No workspace open. Use Open Folder first.')
  return resolveReadablePathWithinRoot(path, root, backend)
}

/** Explicit-root variant used by agent turns whose checkout differs from the project root. */
export async function resolveReadablePathWithinRoot(
  path: string,
  root: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<string> {
  try {
    return await resolvePathWithinRoot(path, root, backend)
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
  const root = getWorkspaceRoot()
  if (!root) throw new Error('No workspace open. Use Open Folder first.')
  return assertWriteTargetWithinRoot(absPath, root, backend)
}

/** Explicit-root write guard for thread checkouts. */
export async function assertWriteTargetWithinRoot(
  absPath: string,
  root: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<void> {
  const absRoot = await backend.realpath(resolve(root))
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
  const root = getWorkspaceRoot()
  if (!root) return false
  return isResolvedPathInsideRoot(absPath, root, backend)
}

/** Explicit-root TOCTOU containment check for task worktrees and shared checkouts. */
export async function isResolvedPathInsideRoot(
  absPath: string,
  root: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<boolean> {
  try {
    const absRoot = await backend.realpath(resolve(root))
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
  const root = getWorkspaceRoot()
  if (!root) return absPath
  return toRelativePathWithinRoot(absPath, root, backend)
}

/** Convert an absolute path to the relative form for one explicit checkout root. */
export async function toRelativePathWithinRoot(
  absPath: string,
  root: string,
  backend: PathBackend = getActivePathBackend(),
): Promise<string> {
  const base = resolve(root)
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
