import * as fsp from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { errorMessage } from '@shared/errors.ts'
import { resolvePathWithinRoot, toRelativePathWithinRoot } from '../workspace.ts'
import { getActiveWorkspaceFs } from '../workspace-fs/get-workspace-fs.ts'
import { runCommand, type CommandResult } from '../exec/command-runner.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { afterSandboxedCommand, spawnInProjectSandbox } from '../../project-sandbox/spawn.ts'
import { isSpawnableWorkingDirectory } from '../../project-sandbox/spawn-cwd.ts'
import { readOnlyWorkspaceSandboxOverlay } from '../../project-sandbox/config.ts'
import { leaseGitSshEnv, withGitInvocationArgs } from '../ssh-workspace/git-ssh-env.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { isGitAvailableForTarget } from '../tool-availability.ts'
import { detectLanguage } from '../language.ts'
import { parseGithubRepoSlug } from '@shared/git/github-link-steering.ts'
import { appendCommitAttribution } from '@shared/git/commit-attribution.ts'
import { imageMimeType } from '@shared/fs/image-path.ts'
import { computeLineDiffStats } from '@shared/diff/line-stats.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import {
  DEFAULT_GIT_BRANCH,
  type GitBranchInfo,
  type GitChange,
  type GitChangeStatus,
  type GitFileDiff,
  type GitPromptState,
  type GitStatusResult,
} from '@shared/types/git.ts'

/**
 * A local checkout can vanish while the app still holds a path to it — a
 * deleted scratch worktree, an unmounted volume, a project record that outlived
 * its folder. Git cannot even start there, and the raw spawn failure escapes as
 * an opaque `spawn /bin/bash ENOENT` rejection (see
 * {@link isSpawnableWorkingDirectory}) rather than something a caller handles.
 * Report it as what it is instead: a failed git command, which every caller in
 * this module already copes with. Remote roots live on the SSH host, so they
 * are never probed against this filesystem.
 */
async function isRootReachable(root: string): Promise<boolean> {
  return isActiveSshWorkspace() || (await isSpawnableWorkingDirectory(root))
}

function unreachableRootResult(root: string): CommandResult {
  return { stdout: '', stderr: `Workspace path no longer exists: ${root}`, code: 1 }
}

async function runGit(
  args: string[],
  root: string | null = getAgentExecutionRoot(),
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = root
  if (!cwd) return { stdout: '', stderr: 'No workspace open.', code: 1 }
  if (!(await isRootReachable(cwd))) return unreachableRootResult(cwd)
  return runCommand('git', args, { cwd })
}

async function runGitRead(
  args: string[],
  root: string | null = getAgentExecutionRoot(),
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = root
  if (!cwd) return { stdout: '', stderr: 'No workspace open.', code: 1 }
  if (!(await isRootReachable(cwd))) return unreachableRootResult(cwd)
  return runCommand('git', args, {
    cwd,
    sandboxConfig: readOnlyWorkspaceSandboxOverlay(cwd),
  })
}

/**
 * Per-root cache of the two `rev-parse` probes that bracket every
 * {@link getGitStatus}: whether `root` is inside a work tree, and its path
 * relative to the repo top. Both are constants for a fixed root — a checkout
 * does not stop being a work tree, and a fixed cwd does not move within its
 * repo — but they were re-spawning on every call, so a `git status` cost three
 * sandboxed `git` subprocesses where only one reads live state.
 *
 * That is invisible at human pace and expensive at agent pace: `canApplyDirectly`
 * in the diff queue runs this per file operation, so a worktree thread renaming
 * fifty files paid a hundred avoidable spawns.
 *
 * **Only positive results are cached.** A negative is the one answer that
 * legitimately flips — `git init` in a plain directory makes it a work tree —
 * and caching that would strand the workspace as permanently git-less.
 *
 * **The cache serves {@link getGitStatus}, not {@link isInsideGitWorkTree}.** A
 * stale positive is safe here because the `git status` that follows fails on its
 * own, so the caller sees the same `null` the probe would have given it. The bare
 * boolean has no such backstop, and #1686 pins the case that proves it matters: a
 * project folder deleted under a running app must answer "no repository" rather
 * than a cached yes. So that entry point always probes live, and a live negative
 * evicts any stale entry — the cache heals the moment anything observes the truth.
 */
const workTreeProbes = new Map<string, { prefix?: string }>()

/**
 * Drop cached probes for `root`, or for every root when called with none.
 * Belt-and-braces for the one case a stale positive is not self-correcting: a
 * root path reused by a *different* repo after its worktree is released.
 */
export function invalidateGitWorkTreeProbe(root?: string): void {
  if (root === undefined) workTreeProbes.clear()
  else workTreeProbes.delete(resolve(root))
}

/**
 * `rev-parse --is-inside-work-tree`, live unless `allowCached`. A positive always
 * populates the cache; a live negative evicts it.
 */
async function confirmInsideWorkTree(root: string, allowCached: boolean): Promise<boolean> {
  const key = resolve(root)
  if (allowCached && workTreeProbes.has(key)) return true
  const { stdout, code } = await runGitRead(['rev-parse', '--is-inside-work-tree'], root)
  if (code !== 0 || stdout.trim() !== 'true') {
    workTreeProbes.delete(key)
    return false
  }
  if (!workTreeProbes.has(key)) workTreeProbes.set(key, {})
  return true
}

/**
 * Cached `rev-parse --show-prefix` — `root`'s path relative to the repo top,
 * used to report status paths workspace-relative. Filled on demand rather than
 * alongside the work-tree probe so callers that only want the boolean still
 * cost one subprocess on a cold cache.
 */
async function workTreePrefix(root: string): Promise<string | null> {
  const key = resolve(root)
  const cached = workTreeProbes.get(key)
  if (cached?.prefix !== undefined) return cached.prefix
  const { stdout, code } = await runGitRead(['rev-parse', '--show-prefix'], root)
  if (code !== 0) return null
  const prefix = stdout.trim()
  if (cached) cached.prefix = prefix
  else workTreeProbes.set(key, { prefix })
  return prefix
}

function toWorkspaceRelativeGitPath(path: string, workspacePrefix: string): string | null {
  const prefix = workspacePrefix.replace(/\/+$/, '')
  if (!prefix) return path
  if (path === prefix) return ''
  const prefixWithSlash = `${prefix}/`
  if (!path.startsWith(prefixWithSlash)) return null
  return path.slice(prefixWithSlash.length)
}

/** Path for `git show ref:path` when cwd is the workspace root (may be a repo subdirectory). */
export function toGitShowPath(workspaceRelativePath: string): string {
  if (workspaceRelativePath.startsWith('./')) return workspaceRelativePath
  return `./${workspaceRelativePath}`
}

function normalizeGitStatusForWorkspace(
  status: GitStatusResult,
  workspacePrefix: string,
): GitStatusResult {
  const normalize = (change: GitChange): GitChange | null => {
    const path = toWorkspaceRelativeGitPath(change.path, workspacePrefix)
    if (!path) return null
    return { ...change, path }
  }
  return {
    staged: status.staged.map(normalize).filter((change): change is GitChange => change !== null),
    unstaged: status.unstaged
      .map(normalize)
      .filter((change): change is GitChange => change !== null),
  }
}

function mapStatus(code: string): GitChangeStatus {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case '?':
      return 'untracked'
    default:
      return 'modified'
  }
}

const STATUS_CODES = new Set([' ', 'M', 'A', 'D', 'R', 'C', 'U', 'T', '?', '!'])

/**
 * Heuristic: does this `-z` token look like a fresh "XY <path>" status record
 * rather than the bare source-path token that follows a rename/copy? Used to
 * keep `-z` parsing aligned when a rename record is missing its source token.
 */
function looksLikeStatusRecord(token: string): boolean {
  const [x, y, sep] = token
  if (token.length < 3 || sep !== ' ' || x === undefined || y === undefined) return false
  return STATUS_CODES.has(x) && STATUS_CODES.has(y)
}

/** Parse `git status --porcelain=v1 -z` into staged and unstaged file lists. */
export function parsePorcelainV1(raw: string): GitStatusResult {
  const staged: GitChange[] = []
  const unstaged: GitChange[] = []
  if (!raw) return { staged, unstaged }

  const entries = raw.split('\0').filter(Boolean)
  for (let i = 0; i < entries.length;) {
    const entry = entries[i]
    if (entry === undefined || entry.length < 3) {
      i++
      continue
    }

    const x = entry[0]
    const y = entry[1]
    if (x === undefined || y === undefined) {
      i++
      continue
    }
    const pathPart = entry.slice(3)

    if (x === '?' && y === '?') {
      unstaged.push({ path: pathPart, status: 'untracked' })
      i++
      continue
    }

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // `-z` rename/copy records span two NUL-delimited tokens:
      //   "XY <path>\0<origPath>\0". The destination path is on the record
      //   line; the following token is the original path. A malformed or
      //   truncated record can be missing that source token. Blindly advancing
      //   by 2 would then swallow the next real status record and mis-align the
      //   rest of the parse (#130). Only consume the paired token when it does
      //   not itself look like a status record; otherwise advance by one.
      const next = entries[i + 1]
      const pairedIsSource = next !== undefined && !looksLikeStatusRecord(next)
      if (x !== ' ' && x !== '?') {
        staged.push({ path: pathPart, status: x === 'R' ? 'renamed' : 'added' })
      }
      if (y !== ' ' && y !== '?') {
        unstaged.push({ path: pathPart, status: y === 'R' ? 'renamed' : mapStatus(y) })
      }
      i += pairedIsSource ? 2 : 1
      continue
    }

    if (x !== ' ' && x !== '?') {
      staged.push({ path: pathPart, status: mapStatus(x) })
    }
    if (y !== ' ' && y !== '?') {
      unstaged.push({ path: pathPart, status: mapStatus(y) })
    }
    i++
  }

  return { staged, unstaged }
}

const BINARY_PLACEHOLDER = '[Binary file — cannot display as text]'

function containsNul(text: string): boolean {
  return text.indexOf('\0') !== -1
}

export interface GitBlobResult {
  /** Decoded text, or a placeholder when binary. Empty string when missing. */
  content: string
  /** True when the blob exists in the given ref (code 0), false on a git error. */
  exists: boolean
  isBinary: boolean
}

/**
 * Classify the result of `git show <ref>:<path>` (#130). A non-zero exit (e.g.
 * the path is absent in `ref`) yields `exists: false`; a clean exit with empty
 * output yields `exists: true` with an empty string, distinguishing a genuinely
 * empty file from a read error. Binary content (NUL bytes survive UTF-8 decode)
 * is replaced with a placeholder rather than mangled into the diff view.
 */
export function classifyGitBlob(stdout: string, code: number): GitBlobResult {
  if (code !== 0) return { content: '', exists: false, isBinary: false }
  if (containsNul(stdout)) {
    return { content: BINARY_PLACEHOLDER, exists: true, isBinary: true }
  }
  return { content: stdout, exists: true, isBinary: false }
}

/**
 * Resolve a renderer-supplied path against the workspace boundary (throws when
 * it escapes the root) and return it workspace-relative, so blob pathspecs are
 * normalized the same way working-tree reads are (`resolveWorkspacePath`).
 */
export async function resolveWorkspaceRelativeGitPath(
  path: string,
  root: string | null = getAgentExecutionRoot(),
): Promise<string> {
  if (!root) throw new Error('No workspace open.')
  return toRelativePathWithinRoot(await resolvePathWithinRoot(path, root), root)
}

async function gitObjectSpec(ref: string, path: string, root?: string | null): Promise<string> {
  const gitPath = toGitShowPath(await resolveWorkspaceRelativeGitPath(path, root))
  return ref === ':' ? `:${gitPath}` : `${ref}:${gitPath}`
}

async function readGitBlob(
  ref: string,
  path: string,
  root?: string | null,
): Promise<GitBlobResult> {
  const { stdout, code } = await runGit(['show', await gitObjectSpec(ref, path, root)], root)
  return classifyGitBlob(stdout, code)
}

async function readWorkingTree(path: string, root: string): Promise<string> {
  try {
    const abs = await resolvePathWithinRoot(path, root)
    return await getActiveWorkspaceFs().readFile(abs, 'utf-8')
  } catch {
    return ''
  }
}

const GIT_IMAGE_MAX_BYTES = 50 * 1024 * 1024
interface TemporaryGitIndex {
  path: string
  cleanup(): Promise<void>
}

/**
 * Allocate the throwaway Git index on the filesystem where Git will run. A
 * remote command cannot use a client-local tmpdir path, and must never fall
 * back to the user's real index when the override is unavailable.
 */
async function createTemporaryGitIndex(root: string): Promise<TemporaryGitIndex> {
  if (!isActiveSshWorkspace()) {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'copse-backup-'))
    const path = join(dir, 'index')
    return {
      path,
      cleanup: async (): Promise<void> => {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      },
    }
  }

  const { stdout, code } = await runCommand('mktemp', ['-d', '-t', 'copse-backup.XXXXXX'], {
    cwd: root,
  })
  const dir = stdout.trim()
  if (code !== 0 || !dir) throw new Error('Could not create remote temporary Git index')
  return {
    path: `${dir}/index`,
    cleanup: async (): Promise<void> => {
      await runCommand('rm', ['-rf', '--', dir], { cwd: root }).catch(() => undefined)
    },
  }
}

async function runGitBuffer(
  args: string[],
  root: string | null = getAgentExecutionRoot(),
): Promise<{ stdout: Buffer; code: number }> {
  const cwd = root
  if (!cwd) return { stdout: Buffer.alloc(0), code: 1 }
  if (!(await isRootReachable(cwd))) return { stdout: Buffer.alloc(0), code: 1 }
  const baseEnv = envForRendererChildProcess()
  const gitSsh = leaseGitSshEnv(baseEnv)
  try {
    const prepared = withGitInvocationArgs(args)
    const proc = await spawnInProjectSandbox('git', prepared, {
      cwd,
      env: gitSsh.env,
      stdio: 'pipe',
      sandboxConfig: readOnlyWorkspaceSandboxOverlay(cwd),
    })
    return await new Promise<{ stdout: Buffer; code: number }>((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      proc.stdout?.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total <= GIT_IMAGE_MAX_BYTES) chunks.push(chunk)
      })
      proc.on('close', (code) => {
        resolve({ stdout: Buffer.concat(chunks), code: code ?? 1 })
      })
      proc.on('error', (err) => {
        reject(err)
      })
    })
  } finally {
    gitSsh.release()
    // Raw binary Git reads bypass command-runner, so release the same per-wrap
    // ASRT lifecycle bookkeeping here. The read-only overlay creates no Linux
    // write-deny mount points of its own.
    afterSandboxedCommand()
  }
}

function bufferToDataUrl(buf: Buffer, mime: string): string {
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function readGitBlobImage(
  ref: string,
  path: string,
  mime: string,
  root: string,
): Promise<string | null> {
  const { stdout, code } = await runGitBuffer(['show', await gitObjectSpec(ref, path, root)], root)
  if (code !== 0 || stdout.length === 0) return null
  return bufferToDataUrl(stdout, mime)
}

async function readWorkingTreeImage(
  path: string,
  mime: string,
  root: string,
): Promise<string | null> {
  try {
    const abs = await resolvePathWithinRoot(path, root)
    const buf = await getActiveWorkspaceFs().readFileBytes(abs)
    if (buf.length === 0) return null
    return bufferToDataUrl(buf, mime)
  } catch {
    return null
  }
}

async function blobWithFallbackImage(
  path: string,
  mime: string,
  root: string,
): Promise<string | null> {
  const index = await readGitBlobImage(':', path, mime, root)
  if (index) return index
  return readGitBlobImage('HEAD', path, mime, root)
}

async function getGitImageDiff(
  path: string,
  staged: boolean,
  mime: string,
  root: string,
): Promise<GitFileDiff> {
  let beforeImage: string | null = null
  let afterImage: string | null = null

  if (staged) {
    beforeImage = await readGitBlobImage('HEAD', path, mime, root)
    afterImage = await readGitBlobImage(':', path, mime, root)
  } else {
    const status = await getGitStatus(root)
    const change = status?.unstaged.find((c) => c.path === path)
    if (change?.status === 'untracked') {
      afterImage = await readWorkingTreeImage(path, mime, root)
    } else if (change?.status === 'deleted') {
      beforeImage = await blobWithFallbackImage(path, mime, root)
    } else {
      beforeImage = await blobWithFallbackImage(path, mime, root)
      afterImage = await readWorkingTreeImage(path, mime, root)
    }
  }

  return {
    path,
    before: '',
    after: '',
    language: detectLanguage(path),
    beforeImage,
    afterImage,
  }
}

export async function isInsideGitWorkTree(
  root: string | null = getAgentExecutionRoot(),
): Promise<boolean> {
  if (!(await isGitAvailableForTarget()) || !root) return false
  // Deliberately uncached: callers gate real work on this answer, and a checkout
  // that vanished under the app has to say so (#1686).
  return confirmInsideWorkTree(root, false)
}

/** `org/repo` from `origin` when the workspace remote is GitHub. */
export async function getGithubRepoSlug(
  root: string | null = getAgentExecutionRoot(),
): Promise<string | null> {
  if (!(await isGitAvailableForTarget()) || !root) return null
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], root)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  const { stdout, code } = await runGit(['remote', 'get-url', 'origin'], root)
  if (code !== 0 || !stdout.trim()) return null
  return parseGithubRepoSlug(stdout.trim())
}

/**
 * Snapshot the ENTIRE working tree — tracked modifications, staged changes, and
 * untracked files — into a commit object, protected from garbage collection
 * behind a `refs/copse/backups/*` ref, WITHOUT touching the user's index or
 * working tree. Returns the ref name (a durable restore point) or null when git
 * is unavailable or the snapshot could not be created.
 *
 * `git stash create` is deliberately not used: it silently omits untracked
 * files, which Copse's ownership check counts as unowned changes — so a stash
 * backup would leave a user's brand-new file unprotected when the agent writes
 * over it. Staging into a throwaway `GIT_INDEX_FILE` with `add -A` captures
 * untracked files too and never disturbs the real index. This is the safety net
 * that lets edits apply/auto-approve over a dirty worktree without prompting:
 * anything the agent overwrites is recoverable from the returned ref.
 */
export async function createWorktreeBackup(
  label: string,
  root: string | null = getAgentExecutionRoot(),
): Promise<string | null> {
  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root))) return null

  let tempIndex: TemporaryGitIndex | undefined
  // A throwaway index isolates our `add -A` from the user's staged state; the
  // identity env lets `commit-tree` succeed even when the repo has no user.name.
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: '',
    GIT_AUTHOR_NAME: 'Copse',
    GIT_AUTHOR_EMAIL: 'copse@localhost',
    GIT_COMMITTER_NAME: 'Copse',
    GIT_COMMITTER_EMAIL: 'copse@localhost',
  }

  try {
    tempIndex = await createTemporaryGitIndex(root)
    env['GIT_INDEX_FILE'] = tempIndex.path
    const run = (args: string[]): Promise<{ stdout: string; code: number }> =>
      runCommand('git', args, { cwd: root, env })
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], root)
    const hasHead = head.code === 0 && head.stdout.trim() !== ''
    // Seed the throwaway index from HEAD so deletions show up in the snapshot.
    // A fresh repo (no HEAD) starts from an empty index instead.
    if (hasHead && (await run(['read-tree', 'HEAD'])).code !== 0) return null
    if ((await run(['add', '-A'])).code !== 0) return null
    const tree = (await run(['write-tree'])).stdout.trim()
    if (!tree) return null
    const commitArgs = ['commit-tree', tree, '-m', `copse backup: ${label}`]
    if (hasHead) commitArgs.push('-p', head.stdout.trim())
    const commit = (await run(commitArgs)).stdout.trim()
    if (!commit) return null
    const ref = `refs/copse/backups/${String(Date.now())}`
    if ((await runGit(['update-ref', ref, commit], root)).code !== 0) return null
    return ref
  } catch {
    return null
  } finally {
    await tempIndex?.cleanup()
  }
}

/**
 * Revert `paths` (workspace-relative) to the content held in a
 * `refs/copse/backups/*` snapshot, undoing whatever Copse or the agent wrote
 * over the user's pre-session work. Only the listed paths are touched — files
 * the agent newly created outside the snapshot are left alone. A path the
 * snapshot did not contain (a pre-session deletion) is removed from the worktree
 * so the result matches the snapshot exactly for those paths. Returns true when
 * every path restored, false when git is unavailable or any restore failed.
 *
 * `git restore --worktree` touches only the working tree, never the user's
 * index, mirroring how {@link createWorktreeBackup} snapshots without disturbing
 * staged state. `--no-overlay` is git's default but is passed explicitly because
 * it is what lets a captured-but-since-recreated path be deleted back to its
 * pre-session absence.
 */
export async function restoreWorktreeBackup(
  ref: string,
  paths: string[],
  root: string | null = getAgentExecutionRoot(),
): Promise<boolean> {
  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root)))
    return false
  if (paths.length === 0) return true
  // Restore one path at a time so a single path git cannot match (a pre-session
  // deletion the agent left absent, which the snapshot also lacks — nothing to
  // recover) never aborts recovery of the paths that DO have work to restore.
  let ok = true
  for (const path of paths) {
    const { code } = await runGit(
      ['restore', '--source', ref, '--worktree', '--no-overlay', '--', path],
      root,
    )
    // A matched path either reverts to the snapshot or, when absent from it, is
    // deleted from the worktree — both are code 0. A non-zero code means git had
    // nothing to match (the path is in neither the snapshot nor the index): the
    // snapshot is the pre-session truth, so drop any agent-created file left at
    // that path best-effort rather than reporting a failed restore.
    if (code === 0) continue
    try {
      await getActiveWorkspaceFs().rm(await resolvePathWithinRoot(path, root), { force: true })
    } catch {
      ok = false
    }
  }
  return ok
}

/**
 * Delete all but the newest `keep` `refs/copse/backups/*` refs so per-turn
 * snapshots don't pile up unboundedly in the user's repository. Refs are named
 * by creation timestamp; the newest `keep` are retained and the rest deleted
 * (their now-unreferenced commits become eligible for git's own GC). No-op when
 * git is unavailable or there is nothing to prune.
 */
export async function pruneWorktreeBackups(
  keep: number,
  root: string | null = getAgentExecutionRoot(),
): Promise<void> {
  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root))) return
  const { stdout, code } = await runGit(
    ['for-each-ref', '--format=%(refname)', 'refs/copse/backups'],
    root,
  )
  if (code !== 0) return
  const refs = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (refs.length <= keep) return
  // Sort by the trailing timestamp so "newest" is robust even if ref names ever
  // vary in length; fall back to lexicographic when a name has no numeric tail.
  const stamp = (ref: string): number => Number.parseInt(ref.split('/').pop() ?? '', 10) || 0
  const stale = refs.sort((a, b) => stamp(b) - stamp(a)).slice(keep)
  for (const ref of stale) {
    await runGit(['update-ref', '-d', ref], root)
  }
}

export async function getGitStatus(
  root: string | null = getAgentExecutionRoot(),
): Promise<GitStatusResult | null> {
  if (!(await isGitAvailableForTarget()) || !root || !(await confirmInsideWorkTree(root, true)))
    return null
  const prefix = await workTreePrefix(root)
  if (prefix === null) return null
  const { stdout, code } = await runGitRead(['status', '--porcelain=v1', '-z'], root)
  if (code !== 0) return null
  return normalizeGitStatusForWorkspace(parsePorcelainV1(stdout), prefix)
}

/** Sum added/deleted line counts from `git diff --numstat` output (binary rows use `-`). */
export function sumDiffNumstat(raw: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [add, del] = line.split('\t')
    if (!add || !del) continue
    if (add !== '-') additions += Number.parseInt(add, 10) || 0
    if (del !== '-') deletions += Number.parseInt(del, 10) || 0
  }
  return { additions, deletions }
}

/**
 * Count added + removed lines in a unified diff (the `+`/`-` body lines, skipping
 * the `+++`/`---` file headers). Operates on the exact text a diff consumer sees,
 * so it correctly counts untracked new files (which `git diff --numstat` omits) as
 * long as they're present in the diff — unlike `sumDiffNumstat`, which reads a
 * separate `--numstat` invocation. Used to gate the post-turn review (#584).
 */
export function countDiffChangedLines(diff: string): number {
  let changed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+') || line.startsWith('-')) changed++
  }
  return changed
}

/**
 * Count lines in untracked text files. `git diff --numstat` omits them entirely
 * (#584), which left the Changes chip stuck at tiny tracked-only totals (often
 * `+1 -1`) while a worktree was full of new agent-authored files.
 */
async function sumUntrackedAdditions(root: string): Promise<number> {
  const status = await getGitStatus(root)
  let additions = 0
  for (const change of status?.unstaged ?? []) {
    if (change.status !== 'untracked') continue
    if (imageMimeType(change.path)) continue
    const text = await readWorkingTree(change.path, root)
    if (text.includes('\0')) continue
    additions += computeLineDiffStats('', text).additions
  }
  return additions
}

/**
 * Live add/delete line totals across the working tree (staged + unstaged +
 * untracked text files), or null when there is nothing to show. Cheap enough to
 * call on every filesystem change so the "Changes" follow-up chip stays current
 * instead of freezing on a per-turn snapshot.
 */
export async function getGitChangeStats(root: string | null = getAgentExecutionRoot()): Promise<{
  additions: number
  deletions: number
} | null> {
  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root))) return null
  const unstaged = await runGit(['diff', '--numstat'], root)
  const staged = await runGit(['diff', '--cached', '--numstat'], root)
  const u = unstaged.code === 0 ? sumDiffNumstat(unstaged.stdout) : { additions: 0, deletions: 0 }
  const s = staged.code === 0 ? sumDiffNumstat(staged.stdout) : { additions: 0, deletions: 0 }
  const untrackedAdditions = await sumUntrackedAdditions(root)
  const additions = u.additions + s.additions + untrackedAdditions
  const deletions = u.deletions + s.deletions
  return additions + deletions > 0 ? { additions, deletions } : null
}

export async function checkoutGitBranch(
  branch: string,
  root: string | null = getAgentExecutionRoot(),
): Promise<void> {
  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root))) {
    throw new Error('No git repository is open.')
  }

  const { stdout, stderr, code } = await runGit(['switch', '--', branch], root)
  if (code !== 0) {
    const message = (stderr || stdout).trim()
    throw new Error(message || `git switch exited with code ${String(code)}`)
  }
}

/**
 * E2E screenshot determinism: when COPSE_PANEL_MOCK_BRANCH is set under e2e, the
 * main process reports this fixed branch instead of the live checkout so the
 * committed reference images don't churn with whatever branch a PR is built
 * from. See docs/testing-strategy.md ("Deterministic screenshots").
 */
function e2eBranchOverride(): string | null {
  if (process.env['COPSE_E2E'] !== '1') return null
  const name = process.env['COPSE_PANEL_MOCK_BRANCH']
  return name && name.length > 0 ? name : null
}

export async function getBranches(
  root: string | null = getAgentExecutionRoot(),
): Promise<GitBranchInfo[]> {
  if (!root) return []
  const override = e2eBranchOverride()
  if (override) {
    // Fixed two-branch list (override + default) keeps the picker menu stable;
    // the rendered menu shows names only, so the date is a placeholder.
    return [
      { name: override, lastCommitDate: '2020-01-01 00:00:00 +0000' },
      { name: DEFAULT_GIT_BRANCH, lastCommitDate: '2020-01-01 00:00:00 +0000' },
    ]
  }
  const { stdout, code } = await runGit(
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short) %(committerdate:iso8601)',
      'refs/heads',
    ],
    root,
  )
  if (code !== 0) return []
  const lines = stdout.trim().split('\n').filter(Boolean)
  const branches: GitBranchInfo[] = []
  for (const line of lines) {
    // Format: "<branch> <date>" — date contains spaces, so split on first space
    const spaceIndex = line.indexOf(' ')
    if (spaceIndex === -1) continue
    branches.push({
      name: line.slice(0, spaceIndex),
      lastCommitDate: line.slice(spaceIndex + 1),
    })
  }
  return branches
}

/**
 * Parse `git rev-list --left-right --count <base>...HEAD` output ("<behind>\t<ahead>"):
 * the left side counts commits on `base` not in HEAD (how far behind), the right
 * side commits on HEAD not in base (how far ahead). Pure, so it's unit-tested
 * without a repo. Returns null on a malformed line.
 */
export function parseAheadBehind(raw: string): { ahead: number; behind: number } | null {
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 2) return null
  const behind = Number.parseInt(parts[0] ?? '', 10)
  const ahead = Number.parseInt(parts[1] ?? '', 10)
  if (Number.isNaN(behind) || Number.isNaN(ahead)) return null
  return { ahead, behind }
}

/**
 * How far the current HEAD is ahead of / behind a base branch, preferring the
 * remote-tracking `origin/<base>` (the true "behind main" the user cares about)
 * and falling back to a local `<base>` ref. Null when neither ref resolves or
 * the counts can't be read.
 */
export async function getAheadBehind(
  base: string,
  root: string | null = getAgentExecutionRoot(),
): Promise<{ ahead: number; behind: number } | null> {
  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root))) return null
  for (const ref of [`origin/${base}`, base]) {
    const { stdout, code } = await runGit(
      ['rev-list', '--left-right', '--count', `${ref}...HEAD`],
      root,
    )
    if (code === 0) {
      const parsed = parseAheadBehind(stdout)
      if (parsed) return parsed
    }
  }
  return null
}

/** Current checked-out branch, or null when detached / outside a repo. */
export async function getCurrentBranchName(
  root: string | null = getAgentExecutionRoot(),
): Promise<string | null> {
  if (!root) return null
  const override = e2eBranchOverride()
  if (override) return override
  const { stdout, code } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  if (code !== 0) return null
  const branch = stdout.trim()
  return branch && branch !== 'HEAD' ? branch : null
}

/** Full SHA of the current `HEAD` commit, or null when unavailable / no commits yet. */
export async function getCurrentCommitHash(
  root: string | null = getAgentExecutionRoot(),
): Promise<string | null> {
  if (!root) return null
  const { stdout, code } = await runGit(['rev-parse', 'HEAD'], root)
  if (code !== 0) return null
  const hash = stdout.trim()
  return hash || null
}

/**
 * Snapshot the repository state a prompt is about to be sent against: the HEAD
 * commit it starts from and whether the working tree is dirty. Captured once per
 * submit so the spine can record what state a turn started from.
 */
export async function getGitPromptState(
  root: string | null = getAgentExecutionRoot(),
): Promise<GitPromptState> {
  const [startingCommit, status] = await Promise.all([
    getCurrentCommitHash(root),
    getGitStatus(root),
  ])
  return {
    startingCommit,
    dirty: Boolean(status && (status.staged.length > 0 || status.unstaged.length > 0)),
  }
}

const ORIGIN_HEAD_PREFIX = 'refs/remotes/origin/'

/** Parse `git symbolic-ref refs/remotes/origin/HEAD` into a branch name. */
export function parseOriginHeadSymbolicRef(ref: string): string | null {
  const trimmed = ref.trim()
  if (!trimmed.startsWith(ORIGIN_HEAD_PREFIX)) return null
  const branch = trimmed.slice(ORIGIN_HEAD_PREFIX.length)
  return branch || null
}

/**
 * Cache of resolved default branches, keyed by repository root. Callers on a UI
 * refresh path (the footer branch status re-reads it on every `message_added`
 * and file-watcher tick) would otherwise spawn up to three `git` processes a
 * second for a value that changes about once in a repository's lifetime.
 */
const defaultBranchCache = new Map<string, { branch: string | null; checkedAt: number }>()

/**
 * A resolved name is effectively immutable: `refs/remotes/origin/HEAD` is a local
 * ref that `git fetch` does not update, so it only moves on an explicit
 * `git remote set-head` (or a re-clone). The TTL exists so a rename still
 * surfaces without an app restart, not because we expect churn.
 */
export const DEFAULT_BRANCH_TTL_MS = 5 * 60 * 1000

/**
 * A `null` result means no remote and no `init.defaultBranch` — the state a
 * freshly `git init`ed project sits in until the user adds a remote, which they
 * usually do within minutes. Re-check that case far sooner than a resolved name.
 */
export const DEFAULT_BRANCH_MISS_TTL_MS = 30 * 1000

/** Test hook — drop every cached default branch. */
export function resetDefaultBranchCache(): void {
  defaultBranchCache.clear()
}

/** Return the default branch name for the current repository. */
export async function getDefaultBranch(
  root: string | null = getAgentExecutionRoot(),
): Promise<string | null> {
  if (!root) return null

  const cached = defaultBranchCache.get(root)
  if (cached) {
    const ttl = cached.branch === null ? DEFAULT_BRANCH_MISS_TTL_MS : DEFAULT_BRANCH_TTL_MS
    if (Date.now() - cached.checkedAt < ttl) return cached.branch
  }

  const branch = await resolveDefaultBranch(root)
  defaultBranchCache.set(root, { branch, checkedAt: Date.now() })
  return branch
}

async function resolveDefaultBranch(root: string): Promise<string | null> {
  const { stdout: originHeadStdout, code: originHeadCode } = await runGit(
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    root,
  )
  if (originHeadCode === 0) {
    const fromOriginHead = parseOriginHeadSymbolicRef(originHeadStdout)
    if (fromOriginHead) return fromOriginHead
  }

  const { stdout: remoteStdout, code: remoteCode } = await runGit(
    ['remote', 'show', 'origin', '-n'],
    root,
  )
  if (remoteCode === 0) {
    const match = remoteStdout.match(/HEAD branch:\s*(.+)/m)
    const remoteDefault = match?.[1]?.trim()
    if (remoteDefault && !remoteDefault.startsWith('(')) return remoteDefault
  }

  const { stdout: configStdout, code: configCode } = await runGit(
    ['config', '--get', 'init.defaultBranch'],
    root,
  )
  if (configCode === 0 && configStdout.trim()) return configStdout.trim()

  return null
}

/** Whether the repository declares submodules, which isolated checkout seeding cannot preserve. */
export async function repositoryHasSubmodules(
  root: string | null = getAgentExecutionRoot(),
): Promise<boolean> {
  if (!root) return false
  // Do not mix a sandboxed Git answer with an unsandboxed filesystem probe.
  // In particular, a project nested beneath another checkout (or mounted into
  // a sandbox) can make `rev-parse --show-toplevel` name the enclosing repo,
  // and an unrelated parent .gitmodules then disables worktrees for the child.
  // The main process can identify the nearest local checkout boundary directly;
  // `.git` may be either a directory or the indirection file used by worktrees.
  let repositoryRoot = await fsp.realpath(root).catch(() => resolve(root))
  for (;;) {
    try {
      await fsp.access(join(repositoryRoot, '.git'))
      break
    } catch {
      const parent = dirname(repositoryRoot)
      if (parent === repositoryRoot) return false
      repositoryRoot = parent
    }
  }
  try {
    await fsp.access(join(repositoryRoot, '.gitmodules'))
    return true
  } catch {
    return false
  }
}

export async function getGitFileDiff(
  path: string,
  staged: boolean,
  root: string | null = getAgentExecutionRoot(),
): Promise<GitFileDiff | null> {
  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root))) return null

  const mime = imageMimeType(path)
  if (mime) return getGitImageDiff(path, staged, mime, root)

  let before = ''
  let after = ''

  // Prefer the index blob, falling back to HEAD only when the path is genuinely
  // absent from the index (not merely an empty file) so empty staged files are
  // not silently replaced by their HEAD version (#130).
  const blobWithFallback = async (path: string): Promise<string> => {
    const index = await readGitBlob(':', path, root)
    if (index.exists) return index.content
    const head = await readGitBlob('HEAD', path, root)
    return head.content
  }

  if (staged) {
    before = (await readGitBlob('HEAD', path, root)).content
    after = (await readGitBlob(':', path, root)).content
  } else {
    const status = await getGitStatus(root)
    const change = status?.unstaged.find((c) => c.path === path)
    if (change?.status === 'untracked') {
      after = await readWorkingTree(path, root)
    } else if (change?.status === 'deleted') {
      before = await blobWithFallback(path)
    } else {
      before = await blobWithFallback(path)
      after = await readWorkingTree(path, root)
    }
  }

  before = normalizeGitDiffText(before)
  after = normalizeGitDiffText(after)

  if (before === after) {
    const diffArgs = ['diff', ...(staged ? ['--cached'] : []), '--', path]
    const { stdout } = await runGit(diffArgs, root)
    if (stdout.trim()) {
      if (staged) {
        before = normalizeGitDiffText((await readGitBlob('HEAD', path, root)).content)
        after = normalizeGitDiffText((await readGitBlob(':', path, root)).content)
      } else {
        before = normalizeGitDiffText((await readGitBlob(':', path, root)).content)
        after = normalizeGitDiffText(await readWorkingTree(path, root))
      }
    }
  }

  return {
    path,
    before,
    after,
    language: detectLanguage(path),
  }
}

function normalizeGitDiffText(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Combined HEAD → working-tree diff for a single file (staged and unstaged
 * changes together), or null when git is unavailable, the file is an image,
 * or the working tree matches HEAD. Powers the file viewer's "Changes" view.
 */
export async function getGitWorkingFileDiff(
  path: string,
  root: string | null = getAgentExecutionRoot(),
): Promise<GitFileDiff | null> {
  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root))) return null
  if (imageMimeType(path)) return null

  const before = normalizeGitDiffText((await readGitBlob('HEAD', path, root)).content)
  const after = normalizeGitDiffText(await readWorkingTree(path, root))
  if (before === after) return null

  return {
    path,
    before,
    after,
    language: detectLanguage(path),
  }
}

export async function getGitStatusText(
  root: string | null = getAgentExecutionRoot(),
): Promise<string> {
  if (!(await isGitAvailableForTarget())) return 'git is not available on this system.'
  if (!root) return 'No workspace open.'
  const { stdout, stderr, code } = await runGit(['status', '--short'], root)
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`
  return stdout.trim() || '(no output)'
}

/** Untracked files don't appear in `git diff`; synthesize an add-all diff via --no-index. */
async function getUntrackedDiff(paths: string[], root: string): Promise<string> {
  const diffs: string[] = []
  for (const p of paths) {
    const rhs = p.startsWith('-') ? `./${p}` : p
    // --no-index always exits 1 when files differ; ignore the code, use the output.
    const { stdout } = await runGit(['diff', '--no-index', '/dev/null', rhs], root)
    if (stdout.trim()) diffs.push(stdout.trimEnd())
  }
  return diffs.join('\n')
}

export async function getGitDiffText(
  path?: string,
  staged = false,
  root: string | null = getAgentExecutionRoot(),
): Promise<string> {
  if (!(await isGitAvailableForTarget())) return 'git is not available on this system.'
  if (!root) return 'No workspace open.'
  const args = ['diff', ...(staged ? ['--cached'] : []), '--', ...(path ? [path] : [])]
  const { stdout, stderr, code } = await runGit(args, root)
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`

  let combined = stdout.trimEnd()

  // `git diff` omits untracked files entirely; include them so `git_diff path=newfile`
  // doesn't misreport "(no output)" for a brand-new file (only for the working-tree view).
  if (!staged) {
    const status = await getGitStatus(root)
    let untracked = (status?.unstaged ?? [])
      .filter((c) => c.status === 'untracked')
      .map((c) => c.path)
    if (path) untracked = untracked.filter((p) => p === path)
    if (untracked.length) {
      const extra = await getUntrackedDiff(untracked, root)
      if (extra) combined = combined ? `${combined}\n${extra}` : extra
    }
  }

  return combined || '(no output)'
}

/**
 * Create a commit, appending the Copse attribution trailer (co-author + the
 * `models` that ran in this thread). Optionally stages all changes first.
 * Local only — never pushes.
 */
export async function commitWithAttribution(
  message: string,
  models: string[],
  stageAll: boolean,
  root: string | null = getAgentExecutionRoot(),
): Promise<string> {
  if (!(await isGitAvailableForTarget())) return 'git is not available on this system.'
  if (!root) return 'No workspace open.'

  if (stageAll) {
    const add = await runGit(['add', '-A'], root)
    if (add.code !== 0) return add.stderr.trim() || `git add exited with code ${String(add.code)}`
  }

  const fullMessage = appendCommitAttribution(message, models)
  const { stdout, stderr, code } = await runGit(['commit', '-m', fullMessage], root)
  if (code !== 0) {
    // `git commit` reports "nothing to commit" and similar on stdout, not stderr.
    return stderr.trim() || stdout.trim() || `git commit exited with code ${String(code)}`
  }
  return stdout.trim() || '(committed)'
}

/**
 * `git show` for read-only inspection, scoped to the workspace. With a `path`,
 * returns that file's contents at `ref` (`git show <ref>:<path>`); the path is
 * resolved through the workspace boundary (via {@link gitObjectSpec}) so it
 * cannot escape the root and is scoped correctly when the workspace is a repo
 * subdirectory. Without a `path`, returns the commit (message + diff) limited to
 * the workspace subtree (`git show <ref> -- .`). A `ref` may not embed an inline
 * `:<path>` — paths must go through the validated `path` argument so the boundary
 * check can't be bypassed.
 */
export async function getGitShowText(
  ref: string,
  path?: string,
  root: string | null = getAgentExecutionRoot(),
): Promise<string> {
  if (!(await isGitAvailableForTarget())) return 'git is not available on this system.'
  if (!root) return 'No workspace open.'
  const trimmedRef = ref.trim()
  if (!trimmedRef) return 'A git ref (commit, tag, or branch) is required.'
  if (trimmedRef.includes(':')) {
    return "Invalid ref: pass a file path via the `path` argument instead of embedding ':<path>' in the ref."
  }
  // A ref beginning with `-` would be parsed by git as an option, not a revision
  // (e.g. `--output=<file>` writes the diff to an arbitrary path, `--ext-diff`
  // runs an external driver). git parses options positionally before `--`, so the
  // trailing `-- .` below does not contain it. Reject up front — no real ref name
  // starts with a dash.
  if (trimmedRef.startsWith('-')) {
    return 'Invalid ref: a git ref cannot start with "-".'
  }

  let args: string[]
  if (path === undefined) {
    args = ['show', trimmedRef, '--', '.']
  } else {
    try {
      // Resolves + validates the path against the workspace boundary; throws when
      // it escapes the root. Caught here so the service is self-contained even if
      // a caller skips its own validation.
      args = ['show', await gitObjectSpec(trimmedRef, path, root)]
    } catch (err) {
      return errorMessage(err)
    }
  }
  const { stdout, stderr, code } = await runGit(args, root)
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`
  return stdout.trim() || '(no output)'
}

export async function getGitLogText(
  maxCount: number,
  path?: string,
  root: string | null = getAgentExecutionRoot(),
): Promise<string> {
  if (!(await isGitAvailableForTarget())) return 'git is not available on this system.'
  if (!root) return 'No workspace open.'
  const args = [
    'log',
    `--max-count=${String(maxCount)}`,
    '--oneline',
    '--',
    ...(path ? [path] : []),
  ]
  const { stdout, stderr, code } = await runGit(args, root)
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`
  return stdout.trim() || '(no output)'
}

/** Recent commits since an ISO timestamp (or the newest `maxCount` when `since` is empty). */
export async function getGitLogSinceText(
  since: string | null,
  maxCount: number,
  path?: string,
): Promise<string> {
  if (!(await isGitAvailableForTarget())) return 'git is not available on this system.'
  const args = ['log', `--max-count=${String(maxCount)}`, '--oneline']
  if (since) args.push(`--since=${since}`)
  args.push('--', ...(path ? [path] : []))
  const { stdout, stderr, code } = await runGit(args)
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`
  return stdout.trim() || '(no commits in this window)'
}
