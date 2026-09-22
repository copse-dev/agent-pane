import { lstat, mkdir, mkdtemp, realpath, rm, rmdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { threadWorktreeBranchName } from '@shared/git/worktree-policy.ts'
import { describeBranchCheckoutFailure } from '@shared/git/branch-held.ts'
import { runCommand } from './exec/command-runner.ts'
import { runSerialized } from './storage/write-queue.ts'
import { copseWorktreesDir } from './storage/copse-paths.ts'
import {
  createWorktreeBackup,
  getDefaultBranch,
  invalidateGitWorkTreeProbe,
} from './github/git-service.ts'
import { registerInternalWorkspaceRoot, unregisterInternalWorkspaceRoot } from './workspace.ts'
import { stopExecutionRootIndexing } from './search/workspace-indexing.ts'
import {
  worktreeManagerSandboxOverlay,
  worktreeReadOnlySandboxOverlay,
} from '../project-sandbox/worktree-config.ts'

const OWNER_ID = /^[\w-]{1,128}$/

export interface WorktreeRecord {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: string | null
  prunable: string | null
}

/**
 * Compare checkout identities without trusting path spelling. Existing paths
 * are canonicalized through the filesystem; missing Windows paths still
 * compare case-insensitively, matching that platform's path semantics.
 */
export function sameWorktreePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const canonical = (path: string): string => {
    const resolved = resolve(path)
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }
  const leftPath = canonical(left)
  const rightPath = canonical(right)
  return platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath
}

export type ThreadWorktreeRecoveryMetadata = Pick<
  ThreadWorktree,
  'baseBranch' | 'baseCommit' | 'createdAt' | 'seededFromDirtyProject'
>

export interface AllocateWorktreeInput {
  projectId: string
  threadId: string
  projectRoot: string
  prompt: string
  baseBranch: string
  /**
   * Carry the project checkout's uncommitted work into the new worktree.
   * Defaults to true; the caller sets it false when those edits belong to a
   * different branch than `baseBranch` (see `decideThreadWorktreePolicy`).
   * Seeding is additionally skipped when the base has moved off the project
   * checkout's own HEAD, whatever the caller asked for.
   */
  seedFromDirtyProject?: boolean
}

export interface ValidateWorktreeInput {
  projectId: string
  threadId: string
  projectRoot: string
  worktree: ThreadWorktree
}

export interface ValidatedThreadWorktree extends ThreadWorktree {
  /** Canonical linked-checkout top level and effective thread execution root. */
  path: string
  root: string
  gitDir: string
  commonGitDir: string
}

export type RetireWorktreeResult =
  | { status: 'removed'; branch: string }
  | { status: 'blocked-dirty'; paths: string[] }
  | { status: 'blocked-unmerged'; branch: string; baseBranch: string }

export type ParkWorktreeResult =
  | { status: 'removed'; branch: string; head: string; upstreamRef: string }
  | { status: 'blocked-dirty'; paths: string[] }
  | { status: 'blocked-unpushed'; branch: string }

export type OrphanRetentionReason = 'dirty' | 'unmerged' | 'detached' | 'unavailable'

export interface PruneSafeOrphansInput {
  projectId: string
  projectRoot: string
  knownThreadIds: ReadonlySet<string>
  baseBranch: string
}

export interface PruneSafeOrphansReport {
  pruned: Array<{ threadId: string; path: string; branch: string }>
  retained: Array<{
    threadId: string
    path: string
    branch: string | null
    reason: OrphanRetentionReason
    paths?: string[]
  }>
}

export class WorktreeAllocationError extends Error {
  readonly recovery: { worktree: ThreadWorktree; snapshotRef: string } | null

  constructor(
    message: string,
    recovery: { worktree: ThreadWorktree; snapshotRef: string } | null = null,
  ) {
    super(message)
    this.name = 'WorktreeAllocationError'
    this.recovery = recovery
  }
}

const WORKTREE_RECOVERY_CONFIG = 'copse-worktree-recovery'

function recoveryConfigKey(branch: string): string {
  return `branch.${branch}.${WORKTREE_RECOVERY_CONFIG}`
}

function encodeRecoveryMetadata(metadata: ThreadWorktreeRecoveryMetadata): string {
  return [
    metadata.baseBranch,
    metadata.baseCommit,
    String(metadata.createdAt),
    metadata.seededFromDirtyProject ? '1' : '0',
  ].join('\t')
}

function decodeRecoveryMetadata(raw: string): ThreadWorktreeRecoveryMetadata | null {
  const [baseBranch, baseCommit, createdAtRaw, dirtyRaw, extra] = raw.trim().split('\t')
  if (
    !baseBranch ||
    !baseCommit ||
    !createdAtRaw ||
    (dirtyRaw !== '0' && dirtyRaw !== '1') ||
    extra !== undefined ||
    !/^[0-9a-f]{40,64}$/i.test(baseCommit)
  ) {
    return null
  }
  const createdAt = Number(createdAtRaw)
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null
  return {
    baseBranch,
    baseCommit,
    createdAt,
    seededFromDirtyProject: dirtyRaw === '1',
  }
}

async function writeThreadWorktreeRecoveryMetadata(
  projectRoot: string,
  branch: string,
  metadata: ThreadWorktreeRecoveryMetadata,
): Promise<void> {
  const result = await git(projectRoot, [
    'config',
    '--local',
    recoveryConfigKey(branch),
    encodeRecoveryMetadata(metadata),
  ])
  if (result.code !== 0)
    throw commandFailure('Cannot retain thread worktree recovery metadata', result)
}

/**
 * Read the allocation facts retained next to the thread branch. Thread metadata
 * persistence can fail after Git has already registered the linked checkout;
 * this repository-local marker lets a retry recover the original base even if
 * the project checkout switched branches or the thread branch advanced.
 */
export async function readThreadWorktreeRecoveryMetadata(
  projectRoot: string,
  branch: string,
): Promise<ThreadWorktreeRecoveryMetadata | null> {
  const location = await repositoryLocation(projectRoot)
  await assertBranchName(location.repositoryRoot, branch, 'Thread branch')
  const result = await git(location.repositoryRoot, [
    'config',
    '--local',
    '--get',
    recoveryConfigKey(branch),
  ])
  if (result.code !== 0) return null
  const metadata = decodeRecoveryMetadata(result.stdout)
  if (!metadata) return null
  await assertBranchName(location.repositoryRoot, metadata.baseBranch, 'Base branch')
  return metadata
}

export class ThreadWorktreeDetachedError extends Error {
  readonly branch: string

  constructor(branch: string) {
    super('Thread worktree is on a detached HEAD')
    this.name = 'ThreadWorktreeDetachedError'
    this.branch = branch
  }
}

interface MutableWorktreeRecord {
  path?: string
  head?: string
  branch?: string
  bare?: boolean
  detached?: boolean
  locked?: string
  prunable?: string
}

function completeRecord(record: MutableWorktreeRecord): WorktreeRecord | null {
  if (!record.path) return null
  return {
    path: record.path,
    head: record.head ?? null,
    branch: record.branch?.replace(/^refs\/heads\//, '') ?? null,
    bare: record.bare ?? false,
    detached: record.detached ?? false,
    locked: record.locked ?? null,
    prunable: record.prunable ?? null,
  }
}

/** Parse `git worktree list --porcelain -z` without path quoting assumptions. */
export function parseWorktreePorcelain(raw: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  let current: MutableWorktreeRecord = {}
  const flush = (): void => {
    const completed = completeRecord(current)
    if (completed) records.push(completed)
    current = {}
  }

  for (const token of raw.split('\0')) {
    if (!token) {
      flush()
      continue
    }
    const space = token.indexOf(' ')
    const key = space === -1 ? token : token.slice(0, space)
    const value = space === -1 ? '' : token.slice(space + 1)
    if (key === 'worktree' && current.path) flush()
    switch (key) {
      case 'worktree':
        current.path = value
        break
      case 'HEAD':
        current.head = value
        break
      case 'branch':
        current.branch = value
        break
      case 'bare':
        current.bare = true
        break
      case 'detached':
        current.detached = true
        break
      case 'locked':
        current.locked = value
        break
      case 'prunable':
        current.prunable = value
        break
    }
  }
  flush()
  return records
}

/** Drop a retired/failed worktree's internal-root authority and its index/watcher (#1400). */
export function releaseWorktreeRoot(executionRoot: string): void {
  unregisterInternalWorkspaceRoot(executionRoot)
  stopExecutionRootIndexing(executionRoot)
  // The cached `rev-parse` probes for this root are keyed by path, and a
  // released worktree's path can be reused by the next allocation. A stale
  // positive is otherwise self-correcting (the following `git status` fails on
  // its own), but a *reused* path would answer for the wrong checkout.
  invalidateGitWorkTreeProbe(executionRoot)
}

function assertOwnerId(label: string, value: string): void {
  if (!OWNER_ID.test(value)) throw new Error(`Invalid ${label}`)
}

function worktreesRoot(): string {
  const configured = resolve(copseWorktreesDir())
  const missing: string[] = []
  let existing = configured
  for (;;) {
    try {
      return resolve(realpathSync.native(existing), ...missing.reverse())
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return configured
      missing.push(basename(existing))
      existing = parent
    }
  }
}

export function expectedThreadWorktreePath(projectId: string, threadId: string): string {
  assertOwnerId('project id', projectId)
  assertOwnerId('thread id', threadId)
  const base = worktreesRoot()
  const target = resolve(base, projectId, threadId)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('Worktree path escapes the configured root')
  }
  return target
}

/** A repo-controlled symlink must not turn a checkout grant into a host-directory grant. */
async function assertManagedWorktreePath(projectId: string, path: string): Promise<void> {
  const expectedParent = join(worktreesRoot(), projectId)
  if ((await realpath(dirname(path))) !== expectedParent) {
    throw new Error('Managed worktree parent is redirected outside its configured project path')
  }
  const stat = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (stat?.isSymbolicLink()) throw new Error('Managed worktree path must not be a symlink')
}

function ownErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return undefined
  return Object.getOwnPropertyDescriptor(error, 'code')?.value
}

/**
 * Linux bind-mount sandboxes can grant an existing directory, but cannot make
 * a missing nested path writable through its read-only parent. Materialize the
 * exact manager-owned destination before Git enters the sandbox; never widen
 * the grant to the shared project worktree directory.
 */
async function prepareManagedWorktreeDestination(
  projectId: string,
  path: string,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  await assertManagedWorktreePath(projectId, path)
  let created = false
  try {
    await mkdir(path)
    created = true
  } catch (error) {
    if (ownErrorCode(error) !== 'EEXIST') throw error
    if (!(await lstat(path)).isDirectory()) {
      throw new Error('Managed worktree destination is not a directory', { cause: error })
    }
  }
  await assertManagedWorktreePath(projectId, path)
  return created
}

export async function runWorktreeGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  extraWritePaths: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  // These host-owned bookkeeping operations update branch metadata. Config
  // inspection/updates do not execute repository helpers; hooks remain off for
  // branch deletion. No general Git invocation receives writable configuration.
  const writeConfig =
    (args[0] === 'config' &&
      args[1] === '--local' &&
      /^branch\..+\.copse-worktree-recovery$/.test(args[2] ?? '') &&
      args.length === 4) ||
    (args[0] === 'branch' && args[1] === '-d' && args.length === 3)
  const readOnly =
    ['check-ignore', 'check-ref-format', 'merge-base', 'rev-parse', 'show-ref', 'status'].includes(
      args[0] ?? '',
    ) ||
    (args[0] === 'config' && args[1] === '--local' && args[2] === '--get' && args.length === 4) ||
    (args[0] === 'symbolic-ref' &&
      args[1] === '--quiet' &&
      args[2] === '--short' &&
      args[3] === 'HEAD' &&
      args.length === 4) ||
    (args[0] === 'worktree' && args[1] === 'list')
  return runCommand('git', args, {
    cwd,
    ...(env ? { env } : {}),
    sandboxConfig: readOnly
      ? await worktreeReadOnlySandboxOverlay(cwd, extraWritePaths)
      : await worktreeManagerSandboxOverlay(cwd, extraWritePaths, writeConfig),
    timeout_ms: 60_000,
  })
}

/** Local shorthand: every call in this module goes through the exported helper above. */
const git = runWorktreeGit

/**
 * Remove a checkout after its caller has matched the path to Git's worktree
 * inventory. Linux bind mounts cannot remove their own mount point: Git can
 * finish its bookkeeping and empty the checkout, then exit with EBUSY while
 * deleting the final directory. Accept that narrow partial success only after
 * Git confirms the checkout is no longer registered, and remove the empty
 * directory on the host. `rmdir` will not follow a swapped symlink or delete
 * newly-created content.
 */
export async function removeRegisteredWorktreeCheckout(
  repositoryRoot: string,
  path: string,
  force = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const removed = await git(
    repositoryRoot,
    ['worktree', 'remove', ...(force ? ['--force'] : []), path],
    undefined,
    [path],
  )
  if (removed.code === 0) return removed
  const remainsRegistered = (await listRecords(repositoryRoot)).some((record) =>
    sameWorktreePath(record.path, path),
  )
  if (remainsRegistered) return removed
  try {
    await rmdir(path)
  } catch (error) {
    if (ownErrorCode(error) !== 'ENOENT') return removed
  }
  return { stdout: removed.stdout, stderr: '', code: 0 }
}

function commandFailure(
  action: string,
  result: { stdout: string; stderr: string; code: number },
  /** Present when the command checks out a branch, to explain a held one. */
  branch?: string,
): Error {
  const raw = (result.stderr || result.stdout).trim()
  const detail = branch && raw ? describeBranchCheckoutFailure(branch, raw) : raw
  return new Error(
    detail ? `${action}: ${detail}` : `${action} exited with code ${String(result.code)}`,
  )
}

async function requireGitValue(cwd: string, args: string[], action: string): Promise<string> {
  const result = await git(cwd, args)
  const value = result.stdout.trim()
  if (result.code !== 0 || !value) throw commandFailure(action, result)
  return value
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`
}

async function assertBranchName(cwd: string, branch: string, label: string): Promise<void> {
  const result = await git(cwd, ['check-ref-format', branchRef(branch)])
  if (result.code !== 0) throw new Error(`${label} is not a valid local branch name`)
}

export interface RepositoryLocation {
  repositoryRoot: string
  projectRelativePath: string
}

/** Canonical repository top level for a project root, plus the project's offset inside it. */
export async function repositoryLocation(projectRoot: string): Promise<RepositoryLocation> {
  const canonicalProject = await realpath(resolve(projectRoot))
  const topLevel = await requireGitValue(
    canonicalProject,
    ['rev-parse', '--show-toplevel'],
    'Cannot resolve repository root',
  )
  const canonicalTopLevel = await realpath(topLevel)
  const projectRelativePath = relative(canonicalTopLevel, canonicalProject)
  if (projectRelativePath === '..' || projectRelativePath.startsWith(`..${sep}`)) {
    throw new Error('Project root is outside its resolved Git repository')
  }
  return {
    repositoryRoot: canonicalTopLevel,
    projectRelativePath,
  }
}

async function commonGitDir(root: string): Promise<string> {
  // `repositoryLocation` already proved `root` is Git's top-level checkout.
  // In the ordinary non-bare layout its `.git` directory is the common Git
  // directory by definition, so resolve it directly instead of paying for a
  // final sandboxed `git rev-parse` on every dispatch. A project that is itself
  // a linked checkout, or has any other non-directory `.git` layout, retains
  // Git as the authoritative fallback.
  const dotGit = join(root, '.git')
  try {
    if ((await lstat(dotGit)).isDirectory()) return await realpath(dotGit)
  } catch {
    // Let Git produce the actionable repository error below.
  }
  const value = await requireGitValue(
    root,
    ['rev-parse', '--git-common-dir'],
    'Cannot resolve common Git directory',
  )
  return realpath(isAbsolute(value) ? value : resolve(root, value))
}

async function listRecords(projectRoot: string): Promise<WorktreeRecord[]> {
  const result = await git(projectRoot, ['worktree', 'list', '--porcelain', '-z'])
  if (result.code !== 0) throw commandFailure('Cannot list Git worktrees', result)
  return parseWorktreePorcelain(result.stdout)
}

async function refExists(projectRoot: string, ref: string): Promise<boolean> {
  return (await git(projectRoot, ['show-ref', '--verify', '--quiet', ref])).code === 0
}

async function resolveCommit(projectRoot: string, ref: string): Promise<string | null> {
  const result = await git(projectRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
  const value = result.stdout.trim()
  return result.code === 0 && value ? value : null
}

async function branchExists(projectRoot: string, branch: string): Promise<boolean> {
  return refExists(projectRoot, `refs/heads/${branch}`)
}

/**
 * Read HEAD from the checkout itself. `git worktree list` is authoritative for
 * registration, but its repository-wide inventory can transiently omit branch
 * information while another worktree is being updated. That must not turn an
 * attached checkout into a false "detached HEAD" failure.
 */
async function symbolicHeadBranch(worktreePath: string): Promise<string | null> {
  const result = await git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (result.code === 0) {
    const branch = result.stdout.trim()
    if (branch) return branch
    throw new Error('Thread worktree branch name is empty')
  }
  if (result.code === 1) return null
  throw commandFailure('Cannot inspect thread worktree HEAD', result)
}

/**
 * Best-effort `git fetch origin <branch>` for a repository's default branch, so
 * a worktree based on it starts from the latest remote tip rather than whatever
 * the local branch happened to be pointed at. Never throws: no network / no
 * `origin` remote just means the next resolution step falls back to the local ref.
 */
async function fetchDefaultBranch(projectRoot: string, branch: string): Promise<void> {
  await git(projectRoot, ['fetch', '--quiet', 'origin', branch])
}

async function chooseBranch(
  projectRoot: string,
  prompt: string,
  threadId: string,
): Promise<string> {
  for (let collision = 0; collision < 100; collision++) {
    const candidate = threadWorktreeBranchName(prompt, threadId, collision)
    if (!(await branchExists(projectRoot, candidate))) return candidate
  }
  throw new Error('Could not find an available worktree branch name')
}

async function deleteRef(projectRoot: string, ref: string): Promise<void> {
  const result = await git(projectRoot, ['update-ref', '-d', ref])
  if (result.code !== 0) throw commandFailure(`Cannot delete snapshot ref ${ref}`, result)
}

async function verifySnapshotContent(worktreePath: string, snapshotRef: string): Promise<boolean> {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'copse-worktree-index-')))
  try {
    const env = { GIT_INDEX_FILE: join(temp, 'index') }
    const sandboxConfig = await worktreeReadOnlySandboxOverlay(worktreePath, [temp])
    const run = (args: string[]): ReturnType<typeof runCommand> =>
      runCommand('git', args, {
        cwd: worktreePath,
        env,
        sandboxConfig,
        timeout_ms: 60_000,
      })
    const expected = await run(['read-tree', snapshotRef])
    if (expected.code !== 0) return false
    const trackedDifference = await run(['diff', '--quiet', '--'])
    if (trackedDifference.code !== 0) return false
    const extra = await run(['ls-files', '--others', '--exclude-standard', '-z'])
    return extra.code === 0 && extra.stdout.length === 0
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function seedFromSnapshot(worktreePath: string, snapshotRef: string): Promise<void> {
  const restore = await git(worktreePath, [
    'restore',
    '--source',
    snapshotRef,
    '--worktree',
    '--no-overlay',
    '--',
    '.',
  ])
  if (restore.code !== 0) throw commandFailure('Cannot seed linked worktree', restore)
  if (!(await verifySnapshotContent(worktreePath, snapshotRef))) {
    throw new Error('Seeded worktree content did not match its retained snapshot')
  }
}

async function repositoryIsDirty(projectRoot: string): Promise<boolean> {
  const result = await git(projectRoot, ['status', '--porcelain=v1', '-z'])
  if (result.code !== 0) throw commandFailure('Cannot inspect repository status', result)
  return result.stdout.length > 0
}

/** Allocate one linked checkout, preserving dirty project content without touching it. */
export async function allocateThreadWorktree(
  input: AllocateWorktreeInput,
): Promise<ThreadWorktree> {
  assertOwnerId('project id', input.projectId)
  assertOwnerId('thread id', input.threadId)
  const location = await repositoryLocation(input.projectRoot)
  const projectRoot = location.repositoryRoot

  return runSerialized(`worktree-manager:${projectRoot}`, async () => {
    const target = expectedThreadWorktreePath(input.projectId, input.threadId)
    const existing = (await listRecords(projectRoot)).find((record) =>
      sameWorktreePath(record.path, target),
    )
    if (existing) throw new Error(`Thread worktree is already registered: ${target}`)

    // None of these probes mutates repository state or depends on another.
    // Each Git invocation pays the sandbox/process startup cost, so keep them
    // concurrent on the first-submit path instead of serializing that overhead.
    const [, defaultBranch, dirtyProject, headResult, branch] = await Promise.all([
      assertBranchName(projectRoot, input.baseBranch, 'Base branch'),
      getDefaultBranch(projectRoot),
      repositoryIsDirty(projectRoot),
      git(projectRoot, ['rev-parse', 'HEAD']),
      chooseBranch(projectRoot, input.prompt, input.threadId),
    ])
    const isDefaultBranch = defaultBranch !== null && defaultBranch === input.baseBranch
    if (isDefaultBranch) await fetchDefaultBranch(projectRoot, input.baseBranch)
    const remoteRef = `refs/remotes/origin/${input.baseBranch}`
    // Resolving a ref proves both that it exists and that it names a commit.
    // Do that once per candidate instead of spawning `show-ref` and then
    // immediately spawning `rev-parse` for the same ref. The freshly fetched
    // remote default still wins, with the local branch as the exact fallback.
    const remoteCommit = isDefaultBranch ? await resolveCommit(projectRoot, remoteRef) : null
    const baseCommit =
      remoteCommit ?? (await resolveCommit(projectRoot, branchRef(input.baseBranch)))
    if (!baseCommit) {
      throw new Error(`Base branch "${input.baseBranch}" does not exist in this repository`)
    }
    // Seeding restores the snapshot over the worktree wholesale rather than
    // merging it, so it only means anything when both start from the same
    // commit. A base that moved — a fetched `origin/<default>`, or a project
    // checkout parked on another branch — would have those edits pasted onto an
    // unrelated tree, silently mixing two states. Start clean instead; the
    // user's own checkout still holds the work, untouched.
    const headCommit = headResult.stdout.trim()
    const seedable = (input.seedFromDirtyProject ?? true) && headCommit === baseCommit
    if (dirtyProject && !seedable) {
      console.info(
        `[worktree] Project checkout for thread ${input.threadId} is dirty but its base moved to ${baseCommit.slice(0, 8)}; allocating a clean worktree instead`,
      )
    }
    // It never touches the project root either way, so when the snapshot itself
    // can't be created, falling back to a clean worktree from `baseCommit` is
    // safe — it just means the new worktree won't include those edits.
    const dirty = dirtyProject && seedable
    const snapshotRef = dirty
      ? await createWorktreeBackup(`thread ${input.threadId} seed`, projectRoot)
      : null
    if (dirty && !snapshotRef) {
      console.warn(
        `[worktree] Could not snapshot dirty project for thread ${input.threadId}; allocating a clean worktree instead`,
      )
    }

    const createdTarget = await prepareManagedWorktreeDestination(input.projectId, target)
    const add = await git(
      projectRoot,
      ['worktree', 'add', '-b', branch, target, baseCommit],
      undefined,
      [target],
    )
    if (add.code !== 0) {
      if (createdTarget) await rm(target, { recursive: true, force: true })
      if (snapshotRef) await deleteRef(projectRoot, snapshotRef).catch(() => undefined)
      throw commandFailure('Cannot create linked worktree', add)
    }

    const recoveryMetadata: ThreadWorktreeRecoveryMetadata = {
      baseBranch: input.baseBranch,
      baseCommit,
      createdAt: Date.now(),
      seededFromDirtyProject: snapshotRef !== null,
    }
    try {
      await writeThreadWorktreeRecoveryMetadata(projectRoot, branch, recoveryMetadata)
    } catch (error) {
      await removeRegisteredWorktreeCheckout(projectRoot, target).catch(() => undefined)
      if (snapshotRef) await deleteRef(projectRoot, snapshotRef).catch(() => undefined)
      throw error
    }

    const canonicalPath = await realpath(target)
    const executionRoot = resolve(canonicalPath, location.projectRelativePath)
    await mkdir(executionRoot, { recursive: true })
    const worktree: ThreadWorktree = {
      path: canonicalPath,
      branch,
      ...recoveryMetadata,
    }

    try {
      await registerInternalWorkspaceRoot(canonicalPath, executionRoot)
      if (snapshotRef) {
        await seedFromSnapshot(canonicalPath, snapshotRef)
        await deleteRef(projectRoot, snapshotRef)
      }
      return worktree
    } catch (error) {
      if (snapshotRef) {
        throw new WorktreeAllocationError(error instanceof Error ? error.message : String(error), {
          worktree,
          snapshotRef,
        })
      }
      await removeRegisteredWorktreeCheckout(projectRoot, canonicalPath).catch(() => undefined)
      releaseWorktreeRoot(executionRoot)
      throw error
    }
  })
}

function assertWorktreeMetadata(worktree: unknown): asserts worktree is ThreadWorktree {
  if (
    typeof worktree !== 'object' ||
    worktree === null ||
    !('path' in worktree) ||
    typeof worktree.path !== 'string' ||
    !('branch' in worktree) ||
    typeof worktree.branch !== 'string' ||
    !('baseBranch' in worktree) ||
    typeof worktree.baseBranch !== 'string' ||
    !('baseCommit' in worktree) ||
    typeof worktree.baseCommit !== 'string' ||
    !('createdAt' in worktree) ||
    typeof worktree.createdAt !== 'number' ||
    !Number.isFinite(worktree.createdAt) ||
    worktree.createdAt < 0 ||
    !('seededFromDirtyProject' in worktree) ||
    typeof worktree.seededFromDirtyProject !== 'boolean'
  ) {
    throw new Error('Thread worktree metadata is malformed')
  }
  if (
    ('pullRequestUrl' in worktree && typeof worktree.pullRequestUrl !== 'string') ||
    ('retiredAt' in worktree &&
      (typeof worktree.retiredAt !== 'number' || !Number.isFinite(worktree.retiredAt))) ||
    ('retiredHead' in worktree && typeof worktree.retiredHead !== 'string') ||
    ('upstreamRef' in worktree && typeof worktree.upstreamRef !== 'string')
  ) {
    throw new Error('Thread worktree retirement metadata is malformed')
  }
}

function activeWorktreeMetadata(worktree: ThreadWorktree, path: string): ThreadWorktree {
  return {
    path,
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    baseCommit: worktree.baseCommit,
    createdAt: worktree.createdAt,
    seededFromDirtyProject: worktree.seededFromDirtyProject,
    ...(worktree.pullRequestUrl ? { pullRequestUrl: worktree.pullRequestUrl } : {}),
  }
}

/**
 * Reattach a deliberately retired checkout to its retained local branch.
 * Ordinary missing worktrees remain errors; only explicit retirement metadata
 * authorizes reconstruction.
 */
export async function restoreRetiredThreadWorktree(
  input: ValidateWorktreeInput,
): Promise<ThreadWorktree> {
  assertOwnerId('project id', input.projectId)
  assertOwnerId('thread id', input.threadId)
  assertWorktreeMetadata(input.worktree)
  if (input.worktree.retiredAt === undefined && !input.worktree.pullRequestUrl) {
    return input.worktree
  }
  const location = await repositoryLocation(input.projectRoot)
  const projectRoot = location.repositoryRoot
  const target = expectedThreadWorktreePath(input.projectId, input.threadId)
  return runSerialized(`worktree-manager:${projectRoot}`, async () => {
    const registered = (await listRecords(projectRoot)).find((record) =>
      sameWorktreePath(record.path, target),
    )
    if (!registered) {
      const branchHead = await requireGitValue(
        projectRoot,
        ['rev-parse', '--verify', `${branchRef(input.worktree.branch)}^{commit}`],
        `Cannot restore retired branch ${input.worktree.branch}`,
      )
      if (
        input.worktree.retiredHead &&
        branchHead.toLowerCase() !== input.worktree.retiredHead.toLowerCase()
      ) {
        throw new Error('Retired worktree branch changed since retirement')
      }
      const createdTarget = await prepareManagedWorktreeDestination(input.projectId, target)
      const add = await git(
        projectRoot,
        ['worktree', 'add', target, input.worktree.branch],
        undefined,
        [target],
      )
      if (add.code !== 0) {
        if (createdTarget) await rm(target, { recursive: true, force: true })
        // A retired thread's branch can be checked out elsewhere by the time it
        // is reopened, and "already checked out at …" is unrecoverable without
        // knowing which checkout to free.
        throw commandFailure('Cannot restore retired thread worktree', add, input.worktree.branch)
      }
    }
    const canonicalPath = await realpath(target)
    return activeWorktreeMetadata(input.worktree, canonicalPath)
  })
}

/** Reconstruct and validate persisted metadata; failure never falls back to shared mode. */
export async function validateThreadWorktree(
  input: ValidateWorktreeInput,
): Promise<ValidatedThreadWorktree> {
  assertOwnerId('project id', input.projectId)
  assertOwnerId('thread id', input.threadId)
  assertWorktreeMetadata(input.worktree)
  const location = await repositoryLocation(input.projectRoot)
  const projectRoot = location.repositoryRoot
  if (!/^[0-9a-f]{40,64}$/i.test(input.worktree.baseCommit)) {
    throw new Error('Thread worktree base commit is malformed')
  }
  const expected = expectedThreadWorktreePath(input.projectId, input.threadId)
  if (!sameWorktreePath(input.worktree.path, expected)) {
    throw new Error('Persisted worktree path does not match the configured thread path')
  }

  await assertManagedWorktreePath(input.projectId, expected)

  // These checks share no mutable state. Worktree validation sits on every
  // agent dispatch, so paying for independent Git subprocesses serially adds
  // directly to time-to-first-token.
  const [branchCheck, baseCommitCheck, canonicalPathCheck] = await Promise.allSettled([
    assertBranchName(projectRoot, input.worktree.baseBranch, 'Base branch'),
    requireGitValue(
      projectRoot,
      ['rev-parse', '--verify', `${input.worktree.baseCommit}^{commit}`],
      'Cannot resolve thread worktree base commit',
    ),
    realpath(expected),
  ])
  if (branchCheck.status === 'rejected') throw branchCheck.reason
  if (baseCommitCheck.status === 'rejected') throw baseCommitCheck.reason
  const baseCommit = baseCommitCheck.value
  if (baseCommit.toLowerCase() !== input.worktree.baseCommit.toLowerCase()) {
    throw new Error('Thread worktree base commit does not resolve exactly')
  }
  const canonicalPath = canonicalPathCheck.status === 'fulfilled' ? canonicalPathCheck.value : null
  if (!canonicalPath) throw new Error('Thread worktree is missing')
  const [recordsCheck, liveBranchCheck, executionRootCheck] = await Promise.allSettled([
    listRecords(projectRoot),
    symbolicHeadBranch(canonicalPath),
    realpath(resolve(canonicalPath, location.projectRelativePath)),
  ])
  if (recordsCheck.status === 'rejected') throw recordsCheck.reason
  const records = recordsCheck.value
  const record = records.find((asyncRecord) => {
    try {
      return sameWorktreePath(asyncRecord.path, canonicalPath)
    } catch {
      return false
    }
  })
  if (!record) throw new Error('Thread worktree is not registered with Git')
  // Path is the durable identity. Agents commonly `git checkout -b` inside the
  // linked checkout; read that checkout's HEAD directly and adopt its live
  // branch. The repository-wide worktree inventory above proves registration,
  // but a missing branch field there is not evidence that this HEAD detached.
  if (liveBranchCheck.status === 'rejected') throw liveBranchCheck.reason
  const liveBranch = liveBranchCheck.value
  if (!liveBranch) throw new ThreadWorktreeDetachedError(input.worktree.branch)
  // `symbolicHeadBranch` delegates to `git symbolic-ref`, which rejects a
  // malformed ref before returning its short name. Running `check-ref-format`
  // on that same Git-authored value would add another sandboxed subprocess to
  // every agent dispatch without strengthening this validation.
  if (liveBranch === input.worktree.baseBranch) {
    throw new Error('Thread worktree branch must differ from its recorded base branch')
  }

  const executionRoot = executionRootCheck.status === 'fulfilled' ? executionRootCheck.value : null
  if (!executionRoot) throw new Error('Thread worktree project root is missing')
  const [registrationCheck, commonGitDirCheck] = await Promise.allSettled([
    registerInternalWorkspaceRoot(canonicalPath, executionRoot),
    commonGitDir(projectRoot),
  ])
  if (registrationCheck.status === 'rejected') throw registrationCheck.reason
  if (commonGitDirCheck.status === 'rejected') throw commonGitDirCheck.reason
  const registration = registrationCheck.value
  const projectCommonGitDir = commonGitDirCheck.value
  if (registration.commonGitDir !== projectCommonGitDir) {
    releaseWorktreeRoot(executionRoot)
    throw new Error('Thread worktree belongs to a different repository')
  }
  return {
    ...input.worktree,
    branch: liveBranch,
    path: canonicalPath,
    root: executionRoot,
    gitDir: registration.gitDir,
    commonGitDir: registration.commonGitDir,
  }
}

export async function listProjectWorktrees(projectRoot: string): Promise<WorktreeRecord[]> {
  return listRecords((await repositoryLocation(projectRoot)).repositoryRoot)
}

/** Paths out of `git status --porcelain=v1 -z`, with rename/copy sources folded in. */
export function changedPaths(raw: string): string[] {
  const out: string[] = []
  const entries = raw.split('\0').filter(Boolean)
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!entry || entry.length < 4 || entry[2] !== ' ') continue
    const path = entry.slice(3)
    if (path) out.push(path)
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      const source = entries[index + 1]
      if (source && !(source.length >= 3 && source[2] === ' ')) {
        out.push(source)
        index++
      }
    }
  }
  return [...new Set(out)]
}

/** Remove only a clean worktree whose branch is already contained by its recorded base. */
export async function retireThreadWorktree(
  input: ValidateWorktreeInput,
): Promise<RetireWorktreeResult> {
  const validated = await validateThreadWorktree(input)
  // `git worktree remove` deletes ignored files without `--force`. Include
  // ignored entries so build output or other local-only content is never
  // silently discarded merely because ordinary `git status` calls it clean.
  const status = await git(validated.path, ['status', '--porcelain=v1', '-z', '--ignored=matching'])
  if (status.code !== 0) throw commandFailure('Cannot inspect thread worktree', status)
  if (status.stdout) return { status: 'blocked-dirty', paths: changedPaths(status.stdout) }

  const merged = await git(input.projectRoot, [
    'merge-base',
    '--is-ancestor',
    branchRef(validated.branch),
    branchRef(validated.baseBranch),
  ])
  if (merged.code !== 0) {
    return {
      status: 'blocked-unmerged',
      branch: validated.branch,
      baseBranch: validated.baseBranch,
    }
  }

  const remove = await removeRegisteredWorktreeCheckout(input.projectRoot, validated.path)
  if (remove.code !== 0) throw commandFailure('Cannot retire thread worktree', remove)
  releaseWorktreeRoot(validated.root)
  return { status: 'removed', branch: validated.branch }
}

/**
 * Remove a PR-backed checkout while retaining its local branch. Unlike ordinary
 * retirement this does not require merge: it requires a clean checkout whose
 * local HEAD exactly matches its configured upstream.
 */
export async function parkThreadWorktree(
  input: ValidateWorktreeInput,
): Promise<ParkWorktreeResult> {
  const validated = await validateThreadWorktree(input)
  const status = await git(validated.path, ['status', '--porcelain=v1', '-z', '--ignored=matching'])
  if (status.code !== 0) throw commandFailure('Cannot inspect thread worktree', status)
  if (status.stdout) return { status: 'blocked-dirty', paths: changedPaths(status.stdout) }

  const head = await requireGitValue(
    validated.path,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    'Cannot resolve thread worktree HEAD',
  )
  const upstreamRefResult = await git(validated.path, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ])
  if (upstreamRefResult.code !== 0 || !upstreamRefResult.stdout.trim()) {
    return { status: 'blocked-unpushed', branch: validated.branch }
  }
  const upstreamRef = upstreamRefResult.stdout.trim()
  const upstreamHead = await requireGitValue(
    validated.path,
    ['rev-parse', '--verify', `${upstreamRef}^{commit}`],
    'Cannot resolve thread worktree upstream',
  )
  if (head.toLowerCase() !== upstreamHead.toLowerCase()) {
    return { status: 'blocked-unpushed', branch: validated.branch }
  }

  const remove = await removeRegisteredWorktreeCheckout(input.projectRoot, validated.path)
  if (remove.code !== 0) throw commandFailure('Cannot park thread worktree', remove)
  releaseWorktreeRoot(validated.root)
  return { status: 'removed', branch: validated.branch, head, upstreamRef }
}

/** True when a registered path is managed under this project/thread namespace. */
export function managedThreadIdForPath(projectId: string, path: string): string | null {
  assertOwnerId('project id', projectId)
  const projectDir = resolve(worktreesRoot(), projectId)
  const target = resolve(path)
  if (!sameWorktreePath(dirname(target), projectDir)) return null
  const threadId = basename(target)
  return OWNER_ID.test(threadId) ? threadId : null
}

/**
 * Reconcile registered manager-owned paths whose thread metadata is gone.
 * Only clean branches already contained by the supplied base are removed;
 * every ambiguous or material case is retained and itemized for recovery UI.
 */
export async function pruneSafeOrphans(
  input: PruneSafeOrphansInput,
): Promise<PruneSafeOrphansReport> {
  assertOwnerId('project id', input.projectId)
  const location = await repositoryLocation(input.projectRoot)
  const projectRoot = location.repositoryRoot
  await assertBranchName(projectRoot, input.baseBranch, 'Base branch')
  return runSerialized(`worktree-manager:${projectRoot}`, async () => {
    const report: PruneSafeOrphansReport = { pruned: [], retained: [] }
    for (const record of await listRecords(projectRoot)) {
      const threadId = managedThreadIdForPath(input.projectId, record.path)
      if (!threadId || input.knownThreadIds.has(threadId)) continue
      try {
        await assertManagedWorktreePath(input.projectId, record.path)
      } catch {
        report.retained.push({
          threadId,
          path: record.path,
          branch: record.branch,
          reason: 'unavailable',
        })
        continue
      }
      if (!record.branch || record.detached) {
        report.retained.push({
          threadId,
          path: record.path,
          branch: record.branch,
          reason: 'detached',
        })
        continue
      }

      const status = await git(record.path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored=matching',
      ]).catch(() => null)
      if (!status || status.code !== 0) {
        report.retained.push({
          threadId,
          path: record.path,
          branch: record.branch,
          reason: 'unavailable',
        })
        continue
      }
      if (status.stdout) {
        report.retained.push({
          threadId,
          path: record.path,
          branch: record.branch,
          reason: 'dirty',
          paths: changedPaths(status.stdout),
        })
        continue
      }

      const merged = await git(projectRoot, [
        'merge-base',
        '--is-ancestor',
        branchRef(record.branch),
        branchRef(input.baseBranch),
      ])
      if (merged.code !== 0) {
        report.retained.push({
          threadId,
          path: record.path,
          branch: record.branch,
          reason: 'unmerged',
        })
        continue
      }

      const remove = await removeRegisteredWorktreeCheckout(projectRoot, record.path)
      if (remove.code !== 0) {
        report.retained.push({
          threadId,
          path: record.path,
          branch: record.branch,
          reason: 'unavailable',
        })
        continue
      }
      releaseWorktreeRoot(resolve(record.path, location.projectRelativePath))
      report.pruned.push({ threadId, path: record.path, branch: record.branch })
    }
    return report
  })
}
