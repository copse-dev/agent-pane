import { runCommand } from '../exec/command-runner.ts'
import { runGh, parseGhJson } from './gh-service.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isGitAvailableForTarget, isGhAvailable } from '../tool-availability.ts'
import { isInsideGitWorkTree, getCurrentBranchName, getGitChangeStats } from './git-service.ts'
import type { PrWorkspaceContext } from '@shared/follow-ups/types.ts'
import type { GitBranchStatus, GitOpenPr } from '@shared/types/git.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { ghPrViewListSchema, ghPrViewSchema, type GhPrView } from './gh-json-schemas.ts'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'
import { ghPrHasCiFailures } from './github-ci-service.ts'
import { createInFlightCoalescer } from '../coalesce-in-flight.ts'

const decodeGhPr = decodeWithSchema(ghPrViewSchema)

/**
 * Duplicate-suppressor for the open-PR lookup behind `getGitBranchStatus`.
 * Coalescing only while a lookup is in flight keeps the result live: once it
 * settles, the next caller runs a fresh `gh` query.
 */
const coalesceOpenPrLookup = createInFlightCoalescer<GitOpenPr | null>()

/** Keep process-global in-flight lookups isolated between project identities. */
export function branchStatusLookupKey(
  projectId: string,
  root: string,
  branch: string,
): string {
  return `${projectId}\0${root}\0${branch}`
}

/** Sum line add/delete counts from `git diff --numstat` output. */
export function parseDiffNumstat(raw: string): { additions: number; deletions: number } {
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

/** True when porcelain status marks an unmerged path (UU, AA, DD, …). */
export function porcelainHasMergeConflicts(raw: string): boolean {
  for (const entry of raw.split('\0').filter(Boolean)) {
    const [x, y] = entry
    if (x === undefined || y === undefined) continue
    if (x === 'U' || y === 'U') return true
    if (x === 'A' && y === 'A') return true
    if (x === 'D' && y === 'D') return true
  }
  return false
}

export { ghPrHasCiFailures }

export function ghPrHasMergeConflicts(pr: GhPrView): boolean {
  if (pr.mergeable === 'CONFLICTING') return true
  const status = (pr.mergeStateStatus ?? '').toUpperCase()
  return status === 'DIRTY' || status === 'CONFLICTING'
}

/** Parse `gh pr list --json` output for the first open PR entry. */
export function parseGhOpenPrList(raw: string): GitOpenPr | null {
  if (!raw.trim()) return null
  const list = safeJsonParse(raw, decodeWithSchema(ghPrViewListSchema))
  if (!Array.isArray(list) || list.length === 0) return null
  const pr = list[0]
  if (!pr || typeof pr.number !== 'number' || !pr.url) return null
  return {
    number: pr.number,
    title: nonEmptyStringOr(pr.title?.trim(), `PR #${String(pr.number)}`),
    url: pr.url,
  }
}

async function getOpenPrForBranch(branch: string, root?: string): Promise<GitOpenPr | null> {
  const ghResult = await runGh(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,title,url',
      '--limit',
      '1',
    ],
    root ? { cwd: root } : {},
  )
  return ghResult.code === 0 ? parseGhOpenPrList(ghResult.stdout.trim()) : null
}

/** Parse `gh pr view --json` output into an open PR summary, or null. */
export function parseGhOpenPr(raw: string): GitOpenPr | null {
  if (!raw.trim()) return null
  const pr = safeJsonParse(raw, decodeGhPr)
  if (!pr || pr.state !== 'OPEN') return null
  if (typeof pr.number !== 'number' || !pr.url) return null
  return {
    number: pr.number,
    title: nonEmptyStringOr(pr.title?.trim(), `PR #${String(pr.number)}`),
    url: pr.url,
  }
}

async function runGit(
  args: string[],
  root: string | null,
): Promise<{ stdout: string; code: number }> {
  const cwd = root
  if (!cwd) return { stdout: '', code: 1 }
  const pathPrefix = process.platform === 'win32' ? '' : '/usr/bin:/bin:'
  const { stdout, code } = await runCommand('git', args, {
    cwd,
    env: { PATH: `${pathPrefix}${process.env['PATH'] ?? ''}` },
  })
  return { stdout, code }
}

/**
 * Deterministic workspace + PR signals for follow-up bubbles. No LLM needed.
 * `root` must be the thread execution checkout (shared project or worktree) —
 * never the ambient renderer workspace alone, or worktree threads inherit the
 * shared tree's stale `+1 -1` chip.
 */
export async function getPrWorkspaceContext(
  root: string | null = getWorkspaceRoot(),
): Promise<PrWorkspaceContext> {
  const empty: PrWorkspaceContext = {
    branch: null,
    hasOpenPr: false,
    hasMergeConflicts: false,
    hasCiFailures: false,
    changeStats: null,
  }

  if (!(await isGitAvailableForTarget()) || !root || !(await isInsideGitWorkTree(root))) {
    return empty
  }

  const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null

  const statusResult = await runGit(['status', '--porcelain=v1', '-z'], root)
  const hasLocalConflicts =
    statusResult.code === 0 && porcelainHasMergeConflicts(statusResult.stdout)

  const changeStats = await getGitChangeStats(root)

  let hasOpenPr = false
  let hasMergeConflicts = hasLocalConflicts
  let hasCiFailures = false

  const ghResult = await runGh(
    ['pr', 'view', '--json', 'state,mergeable,mergeStateStatus,statusCheckRollup'],
    { cwd: root },
  )
  if (ghResult.code === 0 && ghResult.stdout.trim()) {
    const pr = parseGhJson(ghResult.stdout, decodeGhPr)
    if (pr?.state === 'OPEN') {
      hasOpenPr = true
      hasMergeConflicts = hasMergeConflicts || ghPrHasMergeConflicts(pr)
      hasCiFailures = ghPrHasCiFailures(pr)
    }
  }

  return {
    branch,
    hasOpenPr,
    hasMergeConflicts,
    hasCiFailures,
    changeStats,
  }
}

/** Branch name and open PR (when `gh` is available) for the status bar. */
export async function getGitBranchStatus(
  projectId: string,
  forBranch?: string,
  root: string | null = getWorkspaceRoot(),
): Promise<GitBranchStatus> {
  const empty: GitBranchStatus = { currentBranch: null, pr: null }
  if (!root) return empty

  // Routes through getCurrentBranchName so the e2e branch override (screenshot
  // determinism) is honored here too, not just bypassed by a raw rev-parse.
  const currentBranch = await getCurrentBranchName(root)
  if (!currentBranch) return empty

  // gh may be absent (minimal installs, the e2e runner image) — checkToolAvailability
  // already reports it. Skip the PR lookup rather than spawning gh, which would
  // reject with "spawn gh ENOENT" and surface an error toast on every workspace
  // that has a branch (failing nearly every workspace e2e spec via afterTest).
  if (!isGhAvailable()) return { currentBranch, pr: null }

  // The PR lookup is a live GitHub API round trip, and a single thread switch
  // asks for the same one twice: the titlebar wants the branch name and the
  // footer chip wants the branch's PR, and both subscribe to `threads_changed`,
  // which the store emits synchronously — so the second request is issued before
  // the first has resolved. Key on the branch actually being looked up (the
  // titlebar passes no `forBranch`, the footer passes the thread's, and for the
  // active thread those are the same branch) so the pair collapses into one call.
  // Include trusted project identity as well: local and SSH projects can share
  // the same path and branch strings, but must never share a GitHub result.
  const targetBranch = forBranch && forBranch !== currentBranch ? forBranch : null
  const pr = await coalesceOpenPrLookup(
    branchStatusLookupKey(projectId, root, targetBranch ?? currentBranch),
    async () => {
      if (targetBranch) return getOpenPrForBranch(targetBranch, root)
      const ghResult = await runGh(['pr', 'view', '--json', 'state,number,title,url'], { cwd: root })
      return ghResult.code === 0 ? parseGhOpenPr(ghResult.stdout) : null
    },
  )

  return { currentBranch, pr }
}
