import { runCommand } from './command-runner.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { isGitAvailable } from './tool-availability.ts'
import { isInsideGitWorkTree } from './git-service.ts'
import type { PrWorkspaceContext } from '@shared/follow-ups/types.ts'

interface GhPrView {
  state?: string
  mergeable?: string
  mergeStateStatus?: string
  statusCheckRollup?: Array<{
    __typename?: string
    name?: string
    status?: string
    conclusion?: string
    state?: string
  }>
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
    if (entry.length < 2) continue
    const x = entry[0]!
    const y = entry[1]!
    if (x === 'U' || y === 'U') return true
    if (x === 'A' && y === 'A') return true
    if (x === 'D' && y === 'D') return true
  }
  return false
}

export function ghPrHasCiFailures(pr: GhPrView): boolean {
  const checks = pr.statusCheckRollup ?? []
  return checks.some((check) => {
    const conclusion = (check.conclusion ?? check.state ?? '').toUpperCase()
    return conclusion === 'FAILURE' || conclusion === 'ERROR' || conclusion === 'TIMED_OUT'
  })
}

export function ghPrHasMergeConflicts(pr: GhPrView): boolean {
  if (pr.mergeable === 'CONFLICTING') return true
  const status = (pr.mergeStateStatus ?? '').toUpperCase()
  return status === 'DIRTY' || status === 'CONFLICTING'
}

async function runGit(args: string[]): Promise<{ stdout: string; code: number }> {
  const cwd = getWorkspaceRoot()
  if (!cwd) return { stdout: '', code: 1 }
  const { stdout, code } = await runCommand('git', args, { cwd })
  return { stdout, code }
}

async function runGh(args: string[]): Promise<{ stdout: string; code: number }> {
  const cwd = getWorkspaceRoot()
  if (!cwd) return { stdout: '', code: 1 }
  const { stdout, code } = await runCommand('gh', args, { cwd })
  return { stdout, code }
}

/** Deterministic workspace + PR signals for follow-up bubbles. No LLM needed. */
export async function getPrWorkspaceContext(): Promise<PrWorkspaceContext> {
  const empty: PrWorkspaceContext = {
    branch: null,
    hasOpenPr: false,
    hasMergeConflicts: false,
    hasCiFailures: false,
    changeStats: null,
  }

  if (!isGitAvailable() || !(await isInsideGitWorkTree())) return empty

  const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null

  const statusResult = await runGit(['status', '--porcelain=v1', '-z'])
  const hasLocalConflicts =
    statusResult.code === 0 && porcelainHasMergeConflicts(statusResult.stdout)

  const unstaged = await runGit(['diff', '--numstat'])
  const staged = await runGit(['diff', '--cached', '--numstat'])
  const unstagedStats =
    unstaged.code === 0 ? parseDiffNumstat(unstaged.stdout) : { additions: 0, deletions: 0 }
  const stagedStats =
    staged.code === 0 ? parseDiffNumstat(staged.stdout) : { additions: 0, deletions: 0 }
  const additions = unstagedStats.additions + stagedStats.additions
  const deletions = unstagedStats.deletions + stagedStats.deletions
  const changeStats = additions + deletions > 0 ? { additions, deletions } : null

  let hasOpenPr = false
  let hasMergeConflicts = hasLocalConflicts
  let hasCiFailures = false

  const ghResult = await runGh([
    'pr',
    'view',
    '--json',
    'state,mergeable,mergeStateStatus,statusCheckRollup',
  ])
  if (ghResult.code === 0 && ghResult.stdout.trim()) {
    try {
      const pr = JSON.parse(ghResult.stdout) as GhPrView
      if (pr.state === 'OPEN') {
        hasOpenPr = true
        hasMergeConflicts = hasMergeConflicts || ghPrHasMergeConflicts(pr)
        hasCiFailures = ghPrHasCiFailures(pr)
      }
    } catch {
      // gh output wasn't JSON — treat as no PR context
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
