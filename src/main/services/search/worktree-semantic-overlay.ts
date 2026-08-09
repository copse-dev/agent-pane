import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { runCommand } from '../exec/command-runner.ts'
import { localWorkspaceFs } from '../workspace-fs/local-workspace-fs.ts'
import { resolvePathWithinRoot } from '../workspace.ts'
import type { SemanticSearchHit } from './semantic-index.ts'

const MAX_DELTA_FILES_TO_SCORE = 200
const MAX_DELTA_FILE_BYTES = 256 * 1024
const MAX_SNIPPET_CHARS = 400
const QUERY_STOP_WORDS = new Set([
  'about',
  'does',
  'from',
  'have',
  'into',
  'that',
  'the',
  'their',
  'this',
  'what',
  'when',
  'where',
  'which',
  'with',
  'work',
])

export interface WorktreeSemanticOverlayOptions {
  query: string
  projectRoot: string
  worktreeRoot: string
  filterPath?: string
  maxResults: number
  baselineHits: SemanticSearchHit[]
  signal?: AbortSignal
}

export interface WorktreeSemanticOverlayResult {
  hits: SemanticSearchHit[]
  changedPathCount: number
}

interface RankedDeltaHit {
  hit: SemanticSearchHit
  score: number
}

function parseNulPaths(stdout: string): string[] {
  return stdout
    .split('\0')
    .filter((path) => path.length > 0 && path !== '.' && !path.startsWith('../'))
}

async function gitPaths(root: string, args: string[], signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await runCommand('git', args, {
    cwd: root,
    // Trusted roots + fixed argv: this comparison must span both checkouts,
    // while a worktree agent's normal seatbelt intentionally denies the shared tree.
    unsandboxed: true,
    ...(signal ? { signal } : {}),
  })
  return parseNulPaths(stdout)
}

async function projectHead(projectRoot: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await runCommand('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: projectRoot,
    unsandboxed: true,
    ...(signal ? { signal } : {}),
  })
  const head = stdout.trim()
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('Cannot identify shared checkout HEAD')
  return head
}

/**
 * Paths whose worktree contents may differ from the live checkout represented
 * by the shared semantic index. Primary-checkout dirt is included so an
 * indexed uncommitted edit cannot leak into a worktree result as a stale hit.
 */
export async function collectWorktreeDeltaPaths(
  projectRoot: string,
  worktreeRoot: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const head = await projectHead(projectRoot, signal)
  const [worktreeTracked, worktreeUntracked, projectDirty, projectUntracked] = await Promise.all([
    gitPaths(
      worktreeRoot,
      ['diff', '--relative', '--no-renames', '--name-only', '-z', head, '--'],
      signal,
    ),
    gitPaths(worktreeRoot, ['ls-files', '--others', '--exclude-standard', '-z'], signal),
    gitPaths(
      projectRoot,
      ['diff', '--relative', '--no-renames', '--name-only', '-z', 'HEAD', '--'],
      signal,
    ),
    gitPaths(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z'], signal),
  ])
  return new Set([...worktreeTracked, ...worktreeUntracked, ...projectDirty, ...projectUntracked])
}

function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []
  return [...new Set(terms.filter((term) => !QUERY_STOP_WORDS.has(term)))]
}

function countTermMatches(value: string, terms: string[]): number {
  const lower = value.toLowerCase()
  let count = 0
  for (const term of terms) {
    if (lower.includes(term)) count++
  }
  return count
}

function bestSnippet(
  lines: string[],
  terms: string[],
): { line: number; text: string; score: number } {
  let bestIndex = 0
  let bestScore = 0
  for (let index = 0; index < lines.length; index++) {
    const score = countTermMatches(lines[index] ?? '', terms)
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  }
  const start = Math.max(0, bestIndex - 1)
  const end = Math.min(lines.length, bestIndex + 2)
  const text = lines
    .slice(start, end)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, MAX_SNIPPET_CHARS)
  return { line: bestIndex + 1, text, score: bestScore }
}

async function scoreDeltaPath(
  path: string,
  worktreeRoot: string,
  terms: string[],
): Promise<RankedDeltaHit | null> {
  let absolutePath: string
  try {
    absolutePath = await resolvePathWithinRoot(path, worktreeRoot, localWorkspaceFs)
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile() || fileStat.size > MAX_DELTA_FILE_BYTES) return null
  } catch {
    return null
  }

  let text: string
  try {
    text = await readFile(absolutePath, 'utf8')
  } catch {
    return null
  }
  if (text.includes('\0')) return null

  const lines = text.split(/\r?\n/)
  const snippet = bestSnippet(lines, terms)
  const pathScore = countTermMatches(path, terms) * 4
  const nameScore = countTermMatches(basename(path), terms) * 2
  const score = pathScore + nameScore + snippet.score
  if (score === 0) return null

  return {
    score,
    hit: {
      path,
      startLine: snippet.line,
      text: `[worktree delta] ${snippet.text}`.trim(),
    },
  }
}

function pathMatchesFilter(path: string, filterPath?: string): boolean {
  return (
    !filterPath || filterPath === '.' || path === filterPath || path.startsWith(`${filterPath}/`)
  )
}

/** Merge the shared semantic snapshot with current worktree-local changes. */
export async function overlayWorktreeSemanticResults(
  options: WorktreeSemanticOverlayOptions,
): Promise<WorktreeSemanticOverlayResult> {
  const changedPaths = await collectWorktreeDeltaPaths(
    options.projectRoot,
    options.worktreeRoot,
    options.signal,
  )
  const scopedChangedPaths = [...changedPaths]
    .filter((path) => pathMatchesFilter(path, options.filterPath))
    .sort()
  const terms = queryTerms(options.query)
  const ranked = (
    await Promise.all(
      scopedChangedPaths
        .slice(0, MAX_DELTA_FILES_TO_SCORE)
        .map((path) => scoreDeltaPath(path, options.worktreeRoot, terms)),
    )
  )
    .filter((result): result is RankedDeltaHit => result !== null)
    .sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path))

  const baseline = options.baselineHits.filter(
    (hit) => !changedPaths.has(hit.path) && pathMatchesFilter(hit.path, options.filterPath),
  )
  return {
    hits: [...ranked.map((result) => result.hit), ...baseline].slice(0, options.maxResults),
    changedPathCount: scopedChangedPaths.length,
  }
}
