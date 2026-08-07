import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import { threadWorktreeBranchName } from '@shared/git/worktree-policy.ts'
import { runCommand } from './exec/command-runner.ts'
import { runSerialized } from './storage/write-queue.ts'
import { copseWorktreesDir } from './storage/copse-paths.ts'
import { createWorktreeBackup, getDefaultBranch } from './github/git-service.ts'
import { registerInternalWorkspaceRoot, unregisterInternalWorkspaceRoot } from './workspace.ts'
import { stopExecutionRootIndexing } from './search/workspace-indexing.ts'

const OWNER_ID = /^[\w-]{1,128}$/
const DISABLE_GIT_HOOKS = ['-c', 'core.hooksPath=/dev/null']

export interface WorktreeRecord {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: string | null
  prunable: string | null
}

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

/**
 * Worktree bookkeeping `git`: repository hooks disabled (a checkout's own hooks
 * must never run because Copse listed or removed it) and unsandboxed, because
 * it operates on the linked-checkout root rather than the project sandbox.
 * Shared with `worktree-inventory.ts`, which manages the same checkouts.
 */
export async function runWorktreeGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runCommand('git', [...DISABLE_GIT_HOOKS, ...args], {
    cwd,
    ...(env ? { env } : {}),
    unsandboxed: true,
    timeout_ms: 60_000,
  })
}

/** Local shorthand: every call in this module goes through the exported helper above. */
const git = runWorktreeGit

function commandFailure(
  action: string,
  result: { stdout: string; stderr: string; code: number },
): Error {
  const detail = (result.stderr || result.stdout).trim()
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

async function branchExists(projectRoot: string, branch: string): Promise<boolean> {
  return refExists(projectRoot, `refs/heads/${branch}`)
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
  const temp = await mkdtemp(join(tmpdir(), 'copse-worktree-index-'))
  try {
    const env = { GIT_INDEX_FILE: join(temp, 'index') }
    const add = await git(worktreePath, ['add', '-A'], env)
    if (add.code !== 0) return false
    const actual = await git(worktreePath, ['write-tree'], env)
    const expected = await git(worktreePath, ['rev-parse', `${snapshotRef}^{tree}`])
    return (
      actual.code === 0 && expected.code === 0 && actual.stdout.trim() === expected.stdout.trim()
    )
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
    const existing = (await listRecords(projectRoot)).find(
      (record) => resolve(record.path) === resolve(target),
    )
    if (existing) throw new Error(`Thread worktree is already registered: ${target}`)

    await assertBranchName(projectRoot, input.baseBranch, 'Base branch')
    const defaultBranch = await getDefaultBranch(projectRoot)
    const isDefaultBranch = defaultBranch !== null && defaultBranch === input.baseBranch
    if (isDefaultBranch) await fetchDefaultBranch(projectRoot, input.baseBranch)
    const remoteRef = `refs/remotes/origin/${input.baseBranch}`
    const useRemoteRef = isDefaultBranch && (await refExists(projectRoot, remoteRef))
    const baseRef = useRemoteRef ? remoteRef : branchRef(input.baseBranch)
    const baseCommit = await requireGitValue(
      projectRoot,
      ['rev-parse', '--verify', `${baseRef}^{commit}`],
      `Cannot resolve base branch ${input.baseBranch}`,
    )
    const dirtyProject = await repositoryIsDirty(projectRoot)
    // Seeding restores the snapshot over the worktree wholesale rather than
    // merging it, so it only means anything when both start from the same
    // commit. A base that moved — a fetched `origin/<default>`, or a project
    // checkout parked on another branch — would have those edits pasted onto an
    // unrelated tree, silently mixing two states. Start clean instead; the
    // user's own checkout still holds the work, untouched.
    const headCommit = (await git(projectRoot, ['rev-parse', 'HEAD'])).stdout.trim()
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

    const branch = await chooseBranch(projectRoot, input.prompt, input.threadId)
    await mkdir(dirname(target), { recursive: true })
    const add = await git(projectRoot, ['worktree', 'add', '-b', branch, target, baseCommit])
    if (add.code !== 0) {
      if (snapshotRef) await deleteRef(projectRoot, snapshotRef).catch(() => undefined)
      throw commandFailure('Cannot create linked worktree', add)
    }

    const canonicalPath = await realpath(target)
    const executionRoot = resolve(canonicalPath, location.projectRelativePath)
    await mkdir(executionRoot, { recursive: true })
    const worktree: ThreadWorktree = {
      path: canonicalPath,
      branch,
      baseBranch: input.baseBranch,
      baseCommit,
      createdAt: Date.now(),
      seededFromDirtyProject: snapshotRef !== null,
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
      await git(projectRoot, ['worktree', 'remove', canonicalPath]).catch(() => undefined)
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
    const registered = (await listRecords(projectRoot)).find(
      (record) => resolve(record.path) === resolve(target),
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
      await mkdir(dirname(target), { recursive: true })
      const add = await git(projectRoot, ['worktree', 'add', target, input.worktree.branch])
      if (add.code !== 0) throw commandFailure('Cannot restore retired thread worktree', add)
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
  await assertBranchName(projectRoot, input.worktree.baseBranch, 'Base branch')
  if (!/^[0-9a-f]{40,64}$/i.test(input.worktree.baseCommit)) {
    throw new Error('Thread worktree base commit is malformed')
  }
  const baseCommit = await requireGitValue(
    projectRoot,
    ['rev-parse', '--verify', `${input.worktree.baseCommit}^{commit}`],
    'Cannot resolve thread worktree base commit',
  )
  if (baseCommit.toLowerCase() !== input.worktree.baseCommit.toLowerCase()) {
    throw new Error('Thread worktree base commit does not resolve exactly')
  }
  const expected = expectedThreadWorktreePath(input.projectId, input.threadId)
  if (resolve(input.worktree.path) !== resolve(expected)) {
    throw new Error('Persisted worktree path does not match the configured thread path')
  }

  const canonicalPath = await realpath(expected).catch(() => null)
  if (!canonicalPath) throw new Error('Thread worktree is missing')
  const record = (await listRecords(projectRoot)).find((asyncRecord) => {
    try {
      return resolve(asyncRecord.path) === resolve(canonicalPath)
    } catch {
      return false
    }
  })
  if (!record) throw new Error('Thread worktree is not registered with Git')
  // Path is the durable identity. Agents commonly `git checkout -b` inside the
  // linked checkout; treat Git's live branch as authoritative and adopt it so
  // reopen / continue is not bricked by stale meta (detached HEAD still fails).
  const liveBranch = record.branch
  if (!liveBranch || record.detached) {
    throw new Error('Thread worktree is on a detached HEAD')
  }
  await assertBranchName(projectRoot, liveBranch, 'Thread branch')
  if (liveBranch === input.worktree.baseBranch) {
    throw new Error('Thread worktree branch must differ from its recorded base branch')
  }

  const executionRoot = await realpath(resolve(canonicalPath, location.projectRelativePath)).catch(
    () => null,
  )
  if (!executionRoot) throw new Error('Thread worktree project root is missing')
  const registration = await registerInternalWorkspaceRoot(canonicalPath, executionRoot)
  const projectCommonGitDir = await commonGitDir(projectRoot)
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

  const remove = await git(input.projectRoot, ['worktree', 'remove', validated.path])
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

  const remove = await git(input.projectRoot, ['worktree', 'remove', validated.path])
  if (remove.code !== 0) throw commandFailure('Cannot park thread worktree', remove)
  releaseWorktreeRoot(validated.root)
  return { status: 'removed', branch: validated.branch, head, upstreamRef }
}

/** True when a registered path is managed under this project/thread namespace. */
export function managedThreadIdForPath(projectId: string, path: string): string | null {
  assertOwnerId('project id', projectId)
  const projectDir = resolve(worktreesRoot(), projectId)
  const target = resolve(path)
  if (dirname(target) !== projectDir) return null
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

      const remove = await git(projectRoot, ['worktree', 'remove', record.path])
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
