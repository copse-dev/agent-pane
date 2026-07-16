import { isInsideGitWorkTree } from './github/git-service.ts'
import {
  getAheadBehind,
  getCurrentBranchName,
  getDefaultBranch,
  getGitChangeStats,
  getGitDiffText,
  getGitStatusText,
} from './github/git-service.ts'

/**
 * Ground-truth repository facts handed to the advisor alongside the transcript.
 *
 * The advisor runs "bare" (no tools, per the Claude-native contract), so it can
 * only reason about repo state from the conversation — and the conversation is a
 * lossy, sometimes-trimmed narration of what the executor *did*, not what the
 * repo *is*. That gap makes the advisor hallucinate state: e.g. reading edit
 * tool calls in the transcript and concluding "the branch has lots of changes"
 * when the working tree is actually clean and the branch is merely behind its
 * base. This block gives it the verified facts to anchor on instead.
 */
export interface AdvisorRepoState {
  branch: string | null
  base: string | null
  /** Commits on HEAD not in base. */
  ahead: number | null
  /** Commits on base not in HEAD (how far "behind main" the branch is). */
  behind: number | null
  /** `git status --short` output ('' when the working tree is clean). */
  statusShort: string
  changeStats: { additions: number; deletions: number } | null
}

/** Max `git status --short` lines to quote before truncating (keeps the block small). */
const MAX_STATUS_LINES = 40

/**
 * Render the repo state as a compact Markdown block, explicitly framed as
 * authoritative over the transcript. Pure and deterministic so it's unit-tested
 * without a repo. Always renders a block — the "are we even in a repo?" decision
 * belongs to {@link buildAdvisorRepoState}, since a detached HEAD with a clean
 * tree is field-indistinguishable from "no repo".
 */
export function formatAdvisorRepoState(state: AdvisorRepoState): string {
  const lines: string[] = ['## Repository state (verified now — authoritative over the transcript)']

  const divergence =
    state.ahead !== null && state.behind !== null
      ? ` — ${String(state.ahead)} ahead, ${String(state.behind)} behind${
          state.base ? ` \`${state.base}\`` : ''
        }`
      : ''
  lines.push(`- Branch: ${state.branch ? `\`${state.branch}\`` : '(detached)'}${divergence}`)

  const status = state.statusShort.trim()
  if (!status) {
    lines.push('- Working tree: clean (no uncommitted changes)')
  } else {
    const statusLines = status.split('\n')
    const shown = statusLines.slice(0, MAX_STATUS_LINES)
    const stats = state.changeStats
      ? ` (+${String(state.changeStats.additions)} / -${String(state.changeStats.deletions)})`
      : ''
    lines.push(`- Working tree: ${String(statusLines.length)} path(s) changed${stats}`)
    lines.push('```')
    lines.push(...shown)
    if (statusLines.length > shown.length) {
      lines.push(`… ${String(statusLines.length - shown.length)} more`)
    }
    lines.push('```')
  }

  if (state.behind !== null && state.behind > 0) {
    lines.push(
      `- Note: "behind" counts commits on ${
        state.base ? `\`${state.base}\`` : 'the base branch'
      } not yet merged here — not local edits. A large diff against the base can be entirely that gap.`,
    )
  }

  return `${lines.join('\n')}\n\n`
}

/** Max characters of working diff to forward before truncating. */
const MAX_DIFF_CHARS = 8000

/**
 * Pure formatter for the working-diff block: fences the combined diff, caps it,
 * or reports a clean tree. Split from the I/O so the capping/clean-tree/fencing
 * logic is unit-tested without a repo. `getGitDiffText` returns the sentinel
 * `(no output)` for an empty diff.
 */
export function formatAdvisorWorkingDiff(combinedDiff: string, maxChars = MAX_DIFF_CHARS): string {
  const combined = combinedDiff.trim()
  if (!combined || combined === '(no output)') {
    return '## Working diff\n\n(the working tree is clean — no diff to show)\n\n'
  }
  const body =
    combined.length > maxChars ? `${combined.slice(0, maxChars)}\n… (diff truncated)` : combined
  return `## Working diff (staged + unstaged, verified now)\n\n\`\`\`diff\n${body}\n\`\`\`\n\n`
}

/**
 * A fenced block of the current working-tree diff (staged + unstaged + untracked),
 * capped, for when the executor asks the advisor to weigh in on the actual code
 * changes (`include_diff`). The advisor is bare, so only Copse can fetch this —
 * and forwarding it guarantees fresh, untrimmed diff regardless of what the
 * transcript still holds. Best-effort; '' when there is no git context.
 */
export async function buildAdvisorWorkingDiff(maxChars = MAX_DIFF_CHARS): Promise<string> {
  try {
    if (!(await isInsideGitWorkTree())) return ''
    const [unstaged, staged] = await Promise.all([
      getGitDiffText(),
      getGitDiffText(undefined, true),
    ])
    const combined = [staged.trim(), unstaged.trim()]
      .filter((part) => part && part !== '(no output)')
      .join('\n')
    return formatAdvisorWorkingDiff(combined, maxChars)
  } catch {
    return ''
  }
}

/**
 * Gather the verified repo state (git I/O) and format it. Best-effort: any
 * failure degrades to an empty block rather than failing the advisor call.
 */
export async function buildAdvisorRepoState(): Promise<string> {
  try {
    if (!(await isInsideGitWorkTree())) return ''
    const base = await getDefaultBranch()
    const [branch, ahead, statusShort, changeStats] = await Promise.all([
      getCurrentBranchName(),
      base ? getAheadBehind(base) : Promise.resolve(null),
      getGitStatusText(),
      getGitChangeStats(),
    ])
    return formatAdvisorRepoState({
      branch,
      base,
      ahead: ahead?.ahead ?? null,
      behind: ahead?.behind ?? null,
      // getGitStatusText returns sentinel strings when git is unavailable; treat
      // "(no output)" (clean) and any non-status message as an empty status.
      statusShort:
        statusShort === '(no output)' || statusShort.includes('git is not available')
          ? ''
          : statusShort,
      changeStats,
    })
  } catch {
    return ''
  }
}
