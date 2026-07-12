import * as fsp from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { errorMessage } from '@shared/errors.ts'
import { getWorkspaceRoot, resolveWorkspacePath, toRelativePath } from '../workspace.ts'
import { runCommand } from '../exec/command-runner.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { isGitAvailable } from '../tool-availability.ts'
import { detectLanguage } from '../language.ts'
import { parseGithubRepoSlug } from '@shared/git/github-link-steering.ts'
import { appendCommitAttribution } from '@shared/git/commit-attribution.ts'
import { imageMimeType } from '@shared/fs/image-path.ts'
import {
  DEFAULT_GIT_BRANCH,
  type GitBranchInfo,
  type GitChange,
  type GitChangeStatus,
  type GitFileDiff,
  type GitStatusResult,
} from '@shared/types/git.ts'

async function runGit(
  args: string[],
  root: string | null = getWorkspaceRoot(),
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = root
  if (!cwd) return { stdout: '', stderr: 'No workspace open.', code: 1 }
  return runCommand('git', args, { cwd })
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
export function resolveWorkspaceRelativeGitPath(path: string): string {
  return toRelativePath(resolveWorkspacePath(path))
}

function gitObjectSpec(ref: string, path: string): string {
  const gitPath = toGitShowPath(resolveWorkspaceRelativeGitPath(path))
  return ref === ':' ? `:${gitPath}` : `${ref}:${gitPath}`
}

async function readGitBlob(ref: string, path: string): Promise<GitBlobResult> {
  const { stdout, code } = await runGit(['show', gitObjectSpec(ref, path)])
  return classifyGitBlob(stdout, code)
}

async function readWorkingTree(path: string): Promise<string> {
  try {
    const abs = resolveWorkspacePath(path)
    return await fsp.readFile(abs, 'utf-8')
  } catch {
    return ''
  }
}

const GIT_IMAGE_MAX_BYTES = 50 * 1024 * 1024

function runGitBuffer(args: string[]): { stdout: Buffer; code: number } {
  const cwd = getWorkspaceRoot()
  if (!cwd) return { stdout: Buffer.alloc(0), code: 1 }
  const prepared = ['--no-pager', '-c', 'core.pager=cat', '-c', 'color.ui=false', ...args]
  // Strip LLM/provider secrets from the env, matching runCommand (#579).
  const env: NodeJS.ProcessEnv = {
    ...envForRendererChildProcess(),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND'] ?? 'ssh -oBatchMode=yes',
  }
  const result = spawnSync('git', prepared, {
    cwd,
    env,
    encoding: 'buffer',
    maxBuffer: GIT_IMAGE_MAX_BYTES,
  })
  // spawnSync types stdout as non-null, but it is null at runtime when the
  // process fails to spawn (e.g. ENOENT), so the fallback is a real guard.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return { stdout: result.stdout ?? Buffer.alloc(0), code: result.status ?? 1 }
}

function bufferToDataUrl(buf: Buffer, mime: string): string {
  return `data:${mime};base64,${buf.toString('base64')}`
}

// eslint-disable-next-line @typescript-eslint/require-await -- mirrors the async readWorkingTreeImage; both feed the async blob fallback
async function readGitBlobImage(ref: string, path: string, mime: string): Promise<string | null> {
  const { stdout, code } = runGitBuffer(['show', gitObjectSpec(ref, path)])
  if (code !== 0 || stdout.length === 0) return null
  return bufferToDataUrl(stdout, mime)
}

async function readWorkingTreeImage(path: string, mime: string): Promise<string | null> {
  try {
    const abs = resolveWorkspacePath(path)
    const buf = await fsp.readFile(abs)
    if (buf.length === 0) return null
    return bufferToDataUrl(buf, mime)
  } catch {
    return null
  }
}

async function blobWithFallbackImage(path: string, mime: string): Promise<string | null> {
  const index = await readGitBlobImage(':', path, mime)
  if (index) return index
  return readGitBlobImage('HEAD', path, mime)
}

async function getGitImageDiff(path: string, staged: boolean, mime: string): Promise<GitFileDiff> {
  let beforeImage: string | null = null
  let afterImage: string | null = null

  if (staged) {
    beforeImage = await readGitBlobImage('HEAD', path, mime)
    afterImage = await readGitBlobImage(':', path, mime)
  } else {
    const status = await getGitStatus()
    const change = status?.unstaged.find((c) => c.path === path)
    if (change?.status === 'untracked') {
      afterImage = await readWorkingTreeImage(path, mime)
    } else if (change?.status === 'deleted') {
      beforeImage = await blobWithFallbackImage(path, mime)
    } else {
      beforeImage = await blobWithFallbackImage(path, mime)
      afterImage = await readWorkingTreeImage(path, mime)
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

export async function isInsideGitWorkTree(): Promise<boolean> {
  if (!isGitAvailable() || !getWorkspaceRoot()) return false
  const { stdout, code } = await runGit(['rev-parse', '--is-inside-work-tree'])
  return code === 0 && stdout.trim() === 'true'
}

/** `org/repo` from `origin` when the workspace remote is GitHub. */
export async function getGithubRepoSlug(
  root: string | null = getWorkspaceRoot(),
): Promise<string | null> {
  if (!isGitAvailable() || !root) return null
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
export async function createWorktreeBackup(label: string): Promise<string | null> {
  const root = getWorkspaceRoot()
  if (!isGitAvailable() || !root || !(await isInsideGitWorkTree())) return null

  const tmpIndex = join(tmpdir(), `copse-backup-${String(process.pid)}-${String(Date.now())}.index`)
  // A throwaway index isolates our `add -A` from the user's staged state; the
  // identity env lets `commit-tree` succeed even when the repo has no user.name.
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: 'Copse',
    GIT_AUTHOR_EMAIL: 'copse@localhost',
    GIT_COMMITTER_NAME: 'Copse',
    GIT_COMMITTER_EMAIL: 'copse@localhost',
  }
  const run = (args: string[]): Promise<{ stdout: string; code: number }> =>
    runCommand('git', args, { cwd: root, env })

  try {
    const head = await runGit(['rev-parse', '--verify', 'HEAD'])
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
    if ((await runGit(['update-ref', ref, commit])).code !== 0) return null
    return ref
  } catch {
    return null
  } finally {
    await fsp.rm(tmpIndex, { force: true }).catch(() => {})
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
export async function restoreWorktreeBackup(ref: string, paths: string[]): Promise<boolean> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return false
  if (paths.length === 0) return true
  // Restore one path at a time so a single path git cannot match (a pre-session
  // deletion the agent left absent, which the snapshot also lacks — nothing to
  // recover) never aborts recovery of the paths that DO have work to restore.
  let ok = true
  for (const path of paths) {
    const { code } = await runGit([
      'restore',
      '--source',
      ref,
      '--worktree',
      '--no-overlay',
      '--',
      path,
    ])
    // A matched path either reverts to the snapshot or, when absent from it, is
    // deleted from the worktree — both are code 0. A non-zero code means git had
    // nothing to match (the path is in neither the snapshot nor the index): the
    // snapshot is the pre-session truth, so drop any agent-created file left at
    // that path best-effort rather than reporting a failed restore.
    if (code === 0) continue
    try {
      await fsp.rm(resolveWorkspacePath(path), { force: true })
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
export async function pruneWorktreeBackups(keep: number): Promise<void> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return
  const { stdout, code } = await runGit([
    'for-each-ref',
    '--format=%(refname)',
    'refs/copse/backups',
  ])
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
    await runGit(['update-ref', '-d', ref])
  }
}

export async function getGitStatus(): Promise<GitStatusResult | null> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return null
  const { stdout: prefix, code: prefixCode } = await runGit(['rev-parse', '--show-prefix'])
  if (prefixCode !== 0) return null
  const { stdout, code } = await runGit(['status', '--porcelain=v1', '-z'])
  if (code !== 0) return null
  return normalizeGitStatusForWorkspace(parsePorcelainV1(stdout), prefix.trim())
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
 * Live add/delete line totals across the working tree (staged + unstaged), or
 * null when there is nothing to show. Cheap enough to call on every filesystem
 * change so the "Changes" follow-up chip stays current instead of freezing on a
 * per-turn snapshot.
 */
export async function getGitChangeStats(): Promise<{
  additions: number
  deletions: number
} | null> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return null
  const unstaged = await runGit(['diff', '--numstat'])
  const staged = await runGit(['diff', '--cached', '--numstat'])
  const u = unstaged.code === 0 ? sumDiffNumstat(unstaged.stdout) : { additions: 0, deletions: 0 }
  const s = staged.code === 0 ? sumDiffNumstat(staged.stdout) : { additions: 0, deletions: 0 }
  const additions = u.additions + s.additions
  const deletions = u.deletions + s.deletions
  return additions + deletions > 0 ? { additions, deletions } : null
}

export async function checkoutGitBranch(branch: string): Promise<void> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) {
    throw new Error('No git repository is open.')
  }

  const { stdout, stderr, code } = await runGit(['switch', '--', branch])
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

export async function getBranches(): Promise<GitBranchInfo[]> {
  if (!getWorkspaceRoot()) return []
  const override = e2eBranchOverride()
  if (override) {
    // Fixed two-branch list (override + default) keeps the picker menu stable;
    // the rendered menu shows names only, so the date is a placeholder.
    return [
      { name: override, lastCommitDate: '2020-01-01 00:00:00 +0000' },
      { name: DEFAULT_GIT_BRANCH, lastCommitDate: '2020-01-01 00:00:00 +0000' },
    ]
  }
  const { stdout, code } = await runGit([
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short) %(committerdate:iso8601)',
    'refs/heads',
  ])
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

/** Current checked-out branch, or null when detached / outside a repo. */
export async function getCurrentBranchName(): Promise<string | null> {
  if (!getWorkspaceRoot()) return null
  const override = e2eBranchOverride()
  if (override) return override
  const { stdout, code } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (code !== 0) return null
  const branch = stdout.trim()
  return branch && branch !== 'HEAD' ? branch : null
}

/** Return the default branch name for the current repository. */
export async function getDefaultBranch(): Promise<string | null> {
  if (!getWorkspaceRoot()) return null

  const { stdout: remoteStdout, code: remoteCode } = await runGit([
    'remote',
    'show',
    'origin',
    '-n',
  ])
  if (remoteCode === 0) {
    const match = remoteStdout.match(/HEAD branch:\s*(.+)/m)
    const remoteDefault = match?.[1]?.trim()
    if (remoteDefault && !remoteDefault.startsWith('(')) return remoteDefault
  }

  const { stdout: configStdout, code: configCode } = await runGit([
    'config',
    '--get',
    'init.defaultBranch',
  ])
  if (configCode === 0 && configStdout.trim()) return configStdout.trim()

  return DEFAULT_GIT_BRANCH
}

export async function getGitFileDiff(path: string, staged: boolean): Promise<GitFileDiff | null> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return null

  const mime = imageMimeType(path)
  if (mime) return getGitImageDiff(path, staged, mime)

  let before = ''
  let after = ''

  // Prefer the index blob, falling back to HEAD only when the path is genuinely
  // absent from the index (not merely an empty file) so empty staged files are
  // not silently replaced by their HEAD version (#130).
  const blobWithFallback = async (path: string): Promise<string> => {
    const index = await readGitBlob(':', path)
    if (index.exists) return index.content
    const head = await readGitBlob('HEAD', path)
    return head.content
  }

  if (staged) {
    before = (await readGitBlob('HEAD', path)).content
    after = (await readGitBlob(':', path)).content
  } else {
    const status = await getGitStatus()
    const change = status?.unstaged.find((c) => c.path === path)
    if (change?.status === 'untracked') {
      after = await readWorkingTree(path)
    } else if (change?.status === 'deleted') {
      before = await blobWithFallback(path)
    } else {
      before = await blobWithFallback(path)
      after = await readWorkingTree(path)
    }
  }

  before = normalizeGitDiffText(before)
  after = normalizeGitDiffText(after)

  if (before === after) {
    const diffArgs = ['diff', ...(staged ? ['--cached'] : []), '--', path]
    const { stdout } = await runGit(diffArgs)
    if (stdout.trim()) {
      if (staged) {
        before = normalizeGitDiffText((await readGitBlob('HEAD', path)).content)
        after = normalizeGitDiffText((await readGitBlob(':', path)).content)
      } else {
        before = normalizeGitDiffText((await readGitBlob(':', path)).content)
        after = normalizeGitDiffText(await readWorkingTree(path))
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

export async function getGitStatusText(): Promise<string> {
  if (!isGitAvailable()) return 'git is not available on this system.'
  const { stdout, stderr, code } = await runGit(['status', '--short'])
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`
  return stdout.trim() || '(no output)'
}

/** Untracked files don't appear in `git diff`; synthesize an add-all diff via --no-index. */
async function getUntrackedDiff(paths: string[]): Promise<string> {
  const diffs: string[] = []
  for (const p of paths) {
    const rhs = p.startsWith('-') ? `./${p}` : p
    // --no-index always exits 1 when files differ; ignore the code, use the output.
    const { stdout } = await runGit(['diff', '--no-index', '/dev/null', rhs])
    if (stdout.trim()) diffs.push(stdout.trimEnd())
  }
  return diffs.join('\n')
}

export async function getGitDiffText(path?: string, staged = false): Promise<string> {
  if (!isGitAvailable()) return 'git is not available on this system.'
  const args = ['diff', ...(staged ? ['--cached'] : []), '--', ...(path ? [path] : [])]
  const { stdout, stderr, code } = await runGit(args)
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`

  let combined = stdout.trimEnd()

  // `git diff` omits untracked files entirely; include them so `git_diff path=newfile`
  // doesn't misreport "(no output)" for a brand-new file (only for the working-tree view).
  if (!staged) {
    const status = await getGitStatus()
    let untracked = (status?.unstaged ?? [])
      .filter((c) => c.status === 'untracked')
      .map((c) => c.path)
    if (path) untracked = untracked.filter((p) => p === path)
    if (untracked.length) {
      const extra = await getUntrackedDiff(untracked)
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
): Promise<string> {
  if (!isGitAvailable()) return 'git is not available on this system.'
  if (!getWorkspaceRoot()) return 'No workspace open.'

  if (stageAll) {
    const add = await runGit(['add', '-A'])
    if (add.code !== 0) return add.stderr.trim() || `git add exited with code ${String(add.code)}`
  }

  const fullMessage = appendCommitAttribution(message, models)
  const { stdout, stderr, code } = await runGit(['commit', '-m', fullMessage])
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
export async function getGitShowText(ref: string, path?: string): Promise<string> {
  if (!isGitAvailable()) return 'git is not available on this system.'
  if (!getWorkspaceRoot()) return 'No workspace open.'
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
      args = ['show', gitObjectSpec(trimmedRef, path)]
    } catch (err) {
      return errorMessage(err)
    }
  }
  const { stdout, stderr, code } = await runGit(args)
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`
  return stdout.trim() || '(no output)'
}

export async function getGitLogText(maxCount: number, path?: string): Promise<string> {
  if (!isGitAvailable()) return 'git is not available on this system.'
  const args = [
    'log',
    `--max-count=${String(maxCount)}`,
    '--oneline',
    '--',
    ...(path ? [path] : []),
  ]
  const { stdout, stderr, code } = await runGit(args)
  if (code !== 0) return stderr.trim() || `git exited with code ${String(code)}`
  return stdout.trim() || '(no output)'
}
