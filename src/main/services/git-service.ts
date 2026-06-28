import * as fsp from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { getWorkspaceRoot, resolveWorkspacePath, toRelativePath } from './workspace.ts'
import { runCommand } from './command-runner.ts'
import { isGitAvailable } from './tool-availability.ts'
import { detectLanguage } from './language.ts'
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
  if (token.length < 3 || token[2] !== ' ') return false
  return STATUS_CODES.has(token[0]!) && STATUS_CODES.has(token[1]!)
}

/** Parse `git status --porcelain=v1 -z` into staged and unstaged file lists. */
export function parsePorcelainV1(raw: string): GitStatusResult {
  const staged: GitChange[] = []
  const unstaged: GitChange[] = []
  if (!raw) return { staged, unstaged }

  const entries = raw.split('\0').filter(Boolean)
  for (let i = 0; i < entries.length; ) {
    const entry = entries[i]!
    if (entry.length < 3) {
      i++
      continue
    }

    const x = entry[0]!
    const y = entry[1]!
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
  }
  const result = spawnSync('git', prepared, {
    cwd,
    env,
    encoding: 'buffer',
    maxBuffer: GIT_IMAGE_MAX_BYTES,
  })
  return { stdout: result.stdout ?? Buffer.alloc(0), code: result.status ?? 1 }
}

function bufferToDataUrl(buf: Buffer, mime: string): string {
  return `data:${mime};base64,${buf.toString('base64')}`
}

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

export async function getGitStatus(): Promise<GitStatusResult | null> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return null
  const { stdout: prefix, code: prefixCode } = await runGit(['rev-parse', '--show-prefix'])
  if (prefixCode !== 0) return null
  const { stdout, code } = await runGit(['status', '--porcelain=v1', '-z'])
  if (code !== 0) return null
  return normalizeGitStatusForWorkspace(parsePorcelainV1(stdout), prefix.trim())
}

export async function checkoutGitBranch(branch: string): Promise<void> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) {
    throw new Error('No git repository is open.')
  }

  const { stdout, stderr, code } = await runGit(['switch', '--', branch])
  if (code !== 0) {
    const message = (stderr || stdout).trim()
    throw new Error(message || `git switch exited with code ${code}`)
  }
}

export async function getBranches(): Promise<GitBranchInfo[]> {
  if (!getWorkspaceRoot()) return []
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
  if (code !== 0) return stderr.trim() || `git exited with code ${code}`
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
  if (code !== 0) return stderr.trim() || `git exited with code ${code}`

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
    if (add.code !== 0) return add.stderr.trim() || `git add exited with code ${add.code}`
  }

  const fullMessage = appendCommitAttribution(message, models)
  const { stdout, stderr, code } = await runGit(['commit', '-m', fullMessage])
  if (code !== 0) {
    // `git commit` reports "nothing to commit" and similar on stdout, not stderr.
    return stderr.trim() || stdout.trim() || `git commit exited with code ${code}`
  }
  return stdout.trim() || '(committed)'
}

export async function getGitLogText(maxCount: number, path?: string): Promise<string> {
  if (!isGitAvailable()) return 'git is not available on this system.'
  const args = ['log', `--max-count=${maxCount}`, '--oneline', '--', ...(path ? [path] : [])]
  const { stdout, stderr, code } = await runGit(args)
  if (code !== 0) return stderr.trim() || `git exited with code ${code}`
  return stdout.trim() || '(no output)'
}
