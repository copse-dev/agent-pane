import * as fsp from 'node:fs/promises'
import { getWorkspaceRoot, resolveWorkspacePath } from './workspace.ts'
import { runCommand } from './command-runner.ts'
import { isGitAvailable } from './tool-availability.ts'
import { detectLanguage } from './language.ts'
import type { GitChange, GitChangeStatus, GitFileDiff, GitStatusResult } from '@shared/types/git.ts'

async function runGit(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = getWorkspaceRoot()
  if (!cwd) return { stdout: '', stderr: 'No workspace open.', code: 1 }
  return runCommand('git', args, { cwd })
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
      const newPath = entries[i + 1]
      if (!newPath) {
        i++
        continue
      }
      if (x !== ' ' && x !== '?') {
        staged.push({ path: newPath, status: x === 'R' ? 'renamed' : 'added' })
      }
      if (y !== ' ' && y !== '?') {
        unstaged.push({ path: newPath, status: y === 'R' ? 'renamed' : mapStatus(y) })
      }
      i += 2
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

async function readGitBlob(ref: string, path: string): Promise<string> {
  const { stdout, code } = await runGit(['show', `${ref}:${path}`])
  if (code !== 0) return ''
  return stdout
}

async function readWorkingTree(path: string): Promise<string> {
  try {
    const abs = resolveWorkspacePath(path)
    return await fsp.readFile(abs, 'utf-8')
  } catch {
    return ''
  }
}

export async function isInsideGitWorkTree(): Promise<boolean> {
  if (!isGitAvailable() || !getWorkspaceRoot()) return false
  const { stdout, code } = await runGit(['rev-parse', '--is-inside-work-tree'])
  return code === 0 && stdout.trim() === 'true'
}

export async function getGitStatus(): Promise<GitStatusResult | null> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return null
  const { stdout, code } = await runGit(['status', '--porcelain=v1', '-z'])
  if (code !== 0) return null
  return parsePorcelainV1(stdout)
}

export async function getGitFileDiff(path: string, staged: boolean): Promise<GitFileDiff | null> {
  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return null

  let before = ''
  let after = ''

  if (staged) {
    before = await readGitBlob('HEAD', path)
    after = await readGitBlob(':', path)
  } else {
    const status = await getGitStatus()
    const change = status?.unstaged.find((c) => c.path === path)
    if (change?.status === 'untracked') {
      after = await readWorkingTree(path)
    } else if (change?.status === 'deleted') {
      before = await readGitBlob(':', path)
      if (!before) before = await readGitBlob('HEAD', path)
    } else {
      before = await readGitBlob(':', path)
      if (!before) before = await readGitBlob('HEAD', path)
      after = await readWorkingTree(path)
    }
  }

  return {
    path,
    before,
    after,
    language: detectLanguage(path),
  }
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
    // --no-index always exits 1 when files differ; ignore the code, use the output.
    const { stdout } = await runGit(['diff', '--no-index', '--', '/dev/null', p])
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

export async function getGitLogText(maxCount: number, path?: string): Promise<string> {
  if (!isGitAvailable()) return 'git is not available on this system.'
  const args = ['log', `--max-count=${maxCount}`, '--oneline', '--', ...(path ? [path] : [])]
  const { stdout, stderr, code } = await runGit(args)
  if (code !== 0) return stderr.trim() || `git exited with code ${code}`
  return stdout.trim() || '(no output)'
}
