// Stage 1 — Context (docs/plans/copse-reviewer.md, §Pipeline).
//
// What a reviewer gets to see before it starts reading: the diff against the
// merge-base, budgeted PER FILE so a large change degrades by dropping
// low-signal files rather than by cutting off mid-hunk; the repository's own
// instructions; and the test map for the touched files. All of it is read from
// the head checkout on the orchestrator side as data. Nothing here executes.
import { readdir, lstat } from 'node:fs/promises'
import { basename, dirname, extname, join, posix } from 'node:path'
import { readCheckoutFile } from './checkout-fs.ts'
import {
  gitInWorktree,
  runGit,
  type GitRunner,
  type MaterialisedCheckouts,
  type PinnedWorktree,
} from './checkouts.ts'

export type FileDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'

export interface FileDiff {
  /** Repo-relative, forward-slashed path on head (the old path for a deletion). */
  readonly path: string
  readonly oldPath?: string
  readonly status: FileDiffStatus
  readonly additions: number
  readonly deletions: number
  /** The file's diff text as the reviewer will see it; empty when dropped. */
  readonly text: string
  readonly truncated: boolean
  /** Why the text was dropped, when it was. */
  readonly dropped?: string
}

export interface RepositoryInstructions {
  readonly path: string
  readonly text: string
  readonly truncated: boolean
}

export interface TestMapEntry {
  readonly source: string
  /** Test files that plausibly cover `source`, and whether each is itself in the diff. */
  readonly tests: readonly { readonly path: string; readonly changed: boolean }[]
}

export interface ReviewContext {
  readonly mergeBase: string
  readonly headCommit: string
  /** The head checkout, pinned to its git directory for host-side `git_diff`. */
  readonly head: PinnedWorktree
  readonly dirtyWorkingTree: boolean
  readonly files: readonly FileDiff[]
  readonly instructions: readonly RepositoryInstructions[]
  readonly testMap: readonly TestMapEntry[]
  readonly budgetChars: number
  /** Characters of diff text actually handed to the reviewer. */
  readonly usedChars: number
}

/** ~15k tokens of diff at 4 chars/token; a reviewer reads the rest through its tools. */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 60_000
/** A file always keeps at least this much of its diff before being dropped. */
const MIN_FILE_CHARS = 2_000
const INSTRUCTIONS_MAX_CHARS = 6_000
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'] as const

const LOW_SIGNAL_PATTERNS: readonly { readonly test: RegExp; readonly reason: string }[] = [
  {
    test: /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock)$/,
    reason: 'lockfile',
  },
  { test: /\.(snap|min\.js|min\.css|map)$/, reason: 'generated' },
  {
    test: /(^|\/)(dist|build|out|vendor|node_modules|coverage)\//,
    reason: 'build output or vendored',
  },
  { test: /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|mp4|mov)$/, reason: 'binary asset' },
]

/** Why a path is low-signal, or `null` when it is worth a reviewer's attention. */
export function lowSignalReason(path: string): string | null {
  for (const { test, reason } of LOW_SIGNAL_PATTERNS) if (test.test(path)) return reason
  return null
}

interface RawFileDiff {
  readonly path: string
  readonly oldPath?: string
  readonly status: FileDiffStatus
  readonly additions: number
  readonly deletions: number
  readonly text: string
}

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

/** Split a unified diff into per-file entries. Pure; tolerant of what it does not recognise. */
export function splitDiff(diff: string): RawFileDiff[] {
  const files: RawFileDiff[] = []
  const blocks = diff.split(/^(?=diff --git )/m).filter((block) => block.startsWith('diff --git '))
  for (const block of blocks) {
    const header = block.split('\n', 1)[0] ?? ''
    const names = /^diff --git a\/(.+?) b\/(.+)$/.exec(header)
    const oldName = unquote(names?.[1] ?? '')
    const newName = unquote(names?.[2] ?? oldName)
    let status: FileDiffStatus = 'modified'
    if (/^new file mode/m.test(block)) status = 'added'
    else if (/^deleted file mode/m.test(block)) status = 'deleted'
    else if (/^rename from /m.test(block)) status = 'renamed'
    if (/^Binary files .* differ$/m.test(block) || /^GIT binary patch$/m.test(block)) {
      status = 'binary'
    }
    let additions = 0
    let deletions = 0
    for (const line of block.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
    const path = status === 'deleted' ? oldName : newName
    files.push({
      path,
      ...(status === 'renamed' && oldName !== newName ? { oldPath: oldName } : {}),
      status,
      additions,
      deletions,
      text: block,
    })
  }
  return files
}

/** Cut `text` to `max` characters at a line boundary, saying so. */
function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text
  const notice = '\n…(diff truncated here; use git_diff to page through the rest)\n'
  const head = text.slice(0, Math.max(0, max - notice.length))
  const lastNewline = head.lastIndexOf('\n')
  const kept = lastNewline > max / 2 ? head.slice(0, lastNewline) : head
  return `${kept}${notice}`.slice(0, max)
}

/**
 * Fit the per-file diffs into `budgetChars`. Low-signal files are dropped
 * first (they are listed, not shown). If the rest still overflows, every file
 * keeps a share proportional to its size, never less than {@link MIN_FILE_CHARS},
 * and is cut at a line boundary. Pure.
 */
export function budgetFileDiffs(raw: readonly RawFileDiff[], budgetChars: number): FileDiff[] {
  const kept: RawFileDiff[] = []
  const out: FileDiff[] = []
  for (const file of raw) {
    const reason = file.status === 'binary' ? 'binary' : lowSignalReason(file.path)
    if (reason !== null) {
      out.push({ ...file, text: '', truncated: false, dropped: reason })
      continue
    }
    kept.push(file)
  }
  const total = kept.reduce((sum, file) => sum + file.text.length, 0)
  if (total <= budgetChars) {
    for (const file of kept) out.push({ ...file, truncated: false })
    return out
  }
  // Reserve a useful minimum per file before dividing the remaining budget.
  // Once it is full, explicitly omit files instead of multiplying the minimum
  // by an unbounded number of files.
  const selected: RawFileDiff[] = []
  let reserved = 0
  for (const file of kept) {
    const minimum = Math.min(MIN_FILE_CHARS, file.text.length)
    if (reserved + minimum > budgetChars) {
      out.push({ ...file, text: '', truncated: false, dropped: 'diff budget exhausted' })
    } else {
      selected.push(file)
      reserved += minimum
    }
  }
  const extra = selected.reduce(
    (sum, file) => sum + Math.max(0, file.text.length - MIN_FILE_CHARS),
    0,
  )
  for (const file of selected) {
    const minimum = Math.min(MIN_FILE_CHARS, file.text.length)
    const share =
      minimum +
      (extra === 0
        ? 0
        : Math.floor(((budgetChars - reserved) * (file.text.length - minimum)) / extra))
    const text = cutAtLine(file.text, share)
    out.push({ ...file, text, truncated: text.length < file.text.length })
  }
  return out
}

const TEST_SUFFIXES = ['.test', '.spec', '.e2e'] as const

function isTestPath(path: string): boolean {
  const stem = basename(path, extname(path))
  return (
    TEST_SUFFIXES.some((suffix) => stem.endsWith(suffix)) || /(^|\/)(__tests__|tests?)\//.test(path)
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Test files under `dir` (depth-limited) whose stem names `needle`. */
async function findTestsNamed(dir: string, needle: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    let info
    try {
      info = await lstat(path)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      found.push(...(await findTestsNamed(path, needle, depth - 1)))
    } else if (isTestPath(entry) && basename(entry, extname(entry)).startsWith(needle)) {
      found.push(path)
    }
    if (found.length >= 8) break
  }
  return found
}

/**
 * Which tests plausibly cover each changed source file: a sibling `x.test.*` /
 * `x.spec.*`, a `__tests__/x.test.*`, or a same-stem test under a top-level
 * `test`/`tests` directory. Heuristic; the reviewer verifies with its tools.
 */
export async function buildTestMap(
  headCheckout: string,
  files: readonly FileDiff[],
): Promise<TestMapEntry[]> {
  const changed = new Set(files.map((file) => file.path))
  const entries: TestMapEntry[] = []
  for (const file of files) {
    if (file.status === 'deleted' || file.dropped !== undefined || isTestPath(file.path)) continue
    const ext = extname(file.path)
    const stem = basename(file.path, ext)
    const dir = dirname(file.path)
    const candidates = new Set<string>()
    for (const suffix of TEST_SUFFIXES) {
      for (const testExt of [ext, '.ts', '.tsx', '.js', '.mjs']) {
        candidates.add(posix.join(dir, `${stem}${suffix}${testExt}`))
        candidates.add(posix.join(dir, '__tests__', `${stem}${suffix}${testExt}`))
      }
    }
    const tests: { path: string; changed: boolean }[] = []
    for (const candidate of candidates) {
      if (await exists(join(headCheckout, candidate))) {
        tests.push({ path: candidate, changed: changed.has(candidate) })
      }
    }
    for (const top of ['test', 'tests']) {
      for (const found of await findTestsNamed(join(headCheckout, top), stem, 3)) {
        const relative = posix.normalize(found.slice(headCheckout.length + 1).replace(/\\/g, '/'))
        if (!tests.some((test) => test.path === relative)) {
          tests.push({ path: relative, changed: changed.has(relative) })
        }
      }
    }
    entries.push({ source: file.path, tests })
  }
  return entries
}

function readInstructions(headCheckout: string): RepositoryInstructions[] {
  const out: RepositoryInstructions[] = []
  for (const name of INSTRUCTION_FILES) {
    try {
      const text = readCheckoutFile(headCheckout, name)
      const truncated = text.length > INSTRUCTIONS_MAX_CHARS
      out.push({
        path: name,
        text: truncated ? text.slice(0, INSTRUCTIONS_MAX_CHARS) : text,
        truncated,
      })
    } catch {
      // Absent is the common case.
    }
  }
  return out
}

/**
 * A diff over the head checkout, which the cell may have written. No external
 * diff or textconv driver, and no recursion into submodules: for each gitlink
 * a worktree diff would otherwise run `git status` inside `head/<submodule>/`,
 * where the cell-writable `.git` can name filter drivers that then run on the
 * host. The flag, unlike `diff.ignoreSubmodules`, also outranks an `ignore`
 * setting in the checkout's `.gitmodules`. Submodule pointer changes are not
 * shown as a result.
 */
const WORKTREE_DIFF_ARGS = [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=all',
  '--find-renames',
] as const

export interface BuildContextOptions {
  readonly checkouts: MaterialisedCheckouts
  readonly budgetChars?: number
  readonly git?: GitRunner
}

/**
 * The diff of the head checkout (committed plus the overlaid working tree)
 * against the merge-base. Untracked files that were copied in are marked
 * intent-to-add in the throwaway worktree so they appear as additions.
 */
export async function headDiff(checkouts: MaterialisedCheckouts, git: GitRunner): Promise<string> {
  const head = pinnedHead(checkouts)
  if (checkouts.untrackedPaths.length > 0) {
    const added = await gitInWorktree(git, head, [
      'add',
      '--intent-to-add',
      '--',
      ...checkouts.untrackedPaths.map((path) => `:(literal)${path}`),
    ])
    if (added.code !== 0) {
      throw new Error(`Cannot stage untracked context: ${added.stderr.trim()}`)
    }
  }
  const result = await gitInWorktree(git, head, [...WORKTREE_DIFF_ARGS, checkouts.mergeBase, '--'])
  if (result.code !== 0) {
    throw new Error(`Cannot diff head against the merge-base: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function pinnedHead(checkouts: MaterialisedCheckouts): PinnedWorktree {
  return { gitDir: checkouts.headGitDir, workTree: checkouts.reviewHead }
}

export async function buildReviewContext(options: BuildContextOptions): Promise<ReviewContext> {
  const git = options.git ?? runGit
  const budgetChars = options.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
  const files = budgetFileDiffs(splitDiff(await headDiff(options.checkouts, git)), budgetChars)
  return {
    mergeBase: options.checkouts.mergeBase,
    headCommit: options.checkouts.headCommit,
    head: pinnedHead(options.checkouts),
    dirtyWorkingTree: options.checkouts.dirty,
    files,
    instructions: readInstructions(options.checkouts.reviewHead),
    testMap: await buildTestMap(options.checkouts.reviewHead, files),
    budgetChars,
    usedChars: files.reduce((sum, file) => sum + file.text.length, 0),
  }
}

/** The context as the reviewer's opening user message. */
export function renderReviewContext(context: ReviewContext): string {
  const lines: string[] = []
  lines.push(
    `Change under review: head ${context.headCommit.slice(0, 10)}${context.dirtyWorkingTree ? ' plus uncommitted working-tree changes' : ''} against merge-base ${context.mergeBase.slice(0, 10)}.`,
  )
  lines.push('')
  lines.push('Changed files:')
  for (const file of context.files) {
    const stats = `+${String(file.additions)}/-${String(file.deletions)}`
    const note =
      file.dropped !== undefined
        ? ` (diff omitted: ${file.dropped})`
        : file.truncated
          ? ' (diff truncated to fit; read the file for the rest)'
          : ''
    const rename = file.oldPath === undefined ? '' : ` (from ${file.oldPath})`
    lines.push(`- ${file.status} ${file.path}${rename} ${stats}${note}`)
  }
  if (context.testMap.length > 0) {
    lines.push('')
    lines.push('Tests that plausibly cover the changed files:')
    for (const entry of context.testMap) {
      const tests =
        entry.tests.length === 0
          ? 'none found'
          : entry.tests.map((test) => `${test.path}${test.changed ? ' (changed)' : ''}`).join(', ')
      lines.push(`- ${entry.source}: ${tests}`)
    }
  }
  for (const instructions of context.instructions) {
    lines.push('')
    lines.push(
      `Repository instructions from ${instructions.path}${instructions.truncated ? ' (truncated)' : ''}:`,
    )
    lines.push('```')
    lines.push(instructions.text.trimEnd())
    lines.push('```')
  }
  lines.push('')
  lines.push('Diff:')
  lines.push('```diff')
  for (const file of context.files) if (file.text.length > 0) lines.push(file.text.trimEnd())
  lines.push('```')
  return lines.join('\n')
}

/** Retrieve the full diff; pin `headCommit` when placing comments on a forge. */
export async function readFileDiff(
  head: PinnedWorktree,
  mergeBase: string,
  path: string,
  headCommit?: string,
): Promise<string> {
  const result = await gitInWorktree(runGit, head, [
    ...WORKTREE_DIFF_ARGS,
    mergeBase,
    ...(headCommit === undefined ? [] : [headCommit]),
    '--',
    `:(literal)${path}`,
  ])
  if (result.code !== 0) throw new Error(`Cannot read diff: ${result.stderr.trim()}`)
  return result.stdout
}
