// Post-turn review subagent: a read-only agent that inspects the working diff
// after the parent agent finishes an editing turn and reports concerns. Shares
// the explore-subagent loop machinery but with a review-focused tool set and
// system prompt. Pure helpers live here so they can be unit-tested without the
// Electron main process.

/** Tools the parent agent uses to mutate files. A turn that runs any of these
 * changed the workspace and is therefore eligible for a post-turn review. */
export const EDIT_TOOL_NAMES = [
  'write_file',
  'str_replace',
  'delete_file',
  'rename_file',
  'make_directory',
] as const

/** Read-only tools the review subagent may use. Deliberately excludes every
 * write/shell tool so a review can never mutate the workspace. */
export const REVIEW_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'search_code',
  'git_diff',
  'git_status',
  'git_log',
  'staged_diffs',
  'read_staged_diff',
] as const

export type EditToolName = (typeof EDIT_TOOL_NAMES)[number]

/** True when a tool call mutates the workspace (used to gate the review). */
export function isEditTool(name: string): boolean {
  return (EDIT_TOOL_NAMES as readonly string[]).includes(name)
}

export const REVIEW_SYSTEM_PROMPT = `You are a code review subagent for a coding assistant.

The parent agent just finished making changes to the workspace. Your job is to
review the resulting diff for problems before the user sees the result.

Rules:
- Use read_file, git_diff, git_status, git_log, list_dir, search_code, staged_diffs, and read_staged_diff to inspect the changes and surrounding code.
- Do NOT write files, run shell commands, or suggest applying changes yourself — you are read-only.
- Focus on correctness regressions, obvious bugs, missed edge cases, broken contracts, and changes that contradict the stated task. Note missing or stale tests when relevant.
- Be concise and specific: cite file paths and line ranges. Skip style nits unless they cause real problems.
- If the changes look correct and complete, say so in one line. Do not invent concerns.

Your final message must be a short review verdict the user can read at a glance:
start with a one-line summary (e.g. "Looks correct" or "1 likely bug"), then a
terse bulleted list of any concerns (omit the list if there are none).`

const MAX_DIFF_CHARS = 12_000

/** Build the review subagent's seed prompt from the parent goal and working diff. */
export function buildReviewPrompt(parentGoal: string, diff: string): string {
  const trimmedDiff = diff.trim()
  const diffBlock =
    trimmedDiff.length > MAX_DIFF_CHARS
      ? `${trimmedDiff.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated; use git_diff on specific files for the rest)`
      : trimmedDiff || '(git reported no textual diff; use git_status / staged_diffs to inspect.)'

  return [
    `Parent task: ${parentGoal}`,
    '',
    'Review the changes the parent agent just made. Working diff:',
    '',
    '```diff',
    diffBlock,
    '```',
    '',
    'Inspect the diff (and read surrounding code as needed), then return your review verdict.',
  ].join('\n')
}
