// Post-turn review subagent: a read-only agent that inspects the working diff
// after the parent agent finishes an editing turn and reports concerns. Shares
// the explore-subagent loop machinery but with a review-focused tool set and
// system prompt. Pure helpers live here so they can be unit-tested without the
// Electron main process.

import type { TodoItem, TodoUpdateInput } from './wire-types.ts'

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
review the resulting diff for problems before the user sees the result, and to
verify the task plan (if any) matches what was actually done.

Rules:
- Use read_file, git_diff, git_status, git_log, list_dir, search_code, staged_diffs, and read_staged_diff to inspect the changes and surrounding code.
- Do NOT write files, run shell commands, or apply fixes yourself — you are read-only.
- Focus on correctness regressions, obvious bugs, missed edge cases, broken contracts, and changes that contradict the stated task. Note missing or stale tests when relevant.
- When a task plan is provided, check whether open items are truly done. Do not mark work complete in prose only — emit todoUpdates the parent can apply.
- Be concise and specific: cite file paths and line ranges. Skip style nits unless they cause real problems.
- If the changes look correct and the plan is reconciled, say so in one line. Do not invent concerns.

Your final message must include:
1. A short review verdict the user can read at a glance (one-line summary, then terse bullets for concerns).
2. A machine-readable JSON block on its own line, exactly this format:
REVIEW_JSON: {"issuesFound":boolean,"requestFollowUp":boolean,"todoUpdates":[{"id":"...","content":"...","status":"pending|in_progress|completed|cancelled"}],"followUpPrompt":"optional string for the parent agent when requestFollowUp is true"}

Set requestFollowUp true when code fixes are needed OR open todos were left incorrectly incomplete.
todoUpdates may patch existing items by id (merge) or add new items for review findings (omit id).
Omit todoUpdates when no plan changes are needed.`

export interface ParsedReviewVerdict {
  /** User-facing markdown summary (REVIEW_JSON line stripped). */
  summary: string
  issuesFound: boolean
  requestFollowUp: boolean
  todoUpdates: TodoUpdateInput[]
  followUpPrompt: string | null
}

const REVIEW_JSON_PREFIX = 'REVIEW_JSON:'

/** Split review subagent output into user-facing summary and structured verdict. */
export function parseReviewVerdict(raw: string): ParsedReviewVerdict {
  const lines = raw.trim().split('\n')
  let jsonLineIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    if (line.startsWith(REVIEW_JSON_PREFIX)) {
      jsonLineIndex = i
      break
    }
  }

  const summary =
    jsonLineIndex >= 0
      ? lines
          .filter((_, i) => i !== jsonLineIndex)
          .join('\n')
          .trim()
      : raw.trim()

  if (jsonLineIndex < 0) {
    const issuesFound = /\b(likely bug|concern|issue|missing|incorrect|should fix)\b/i.test(summary)
    return {
      summary,
      issuesFound,
      requestFollowUp: issuesFound,
      todoUpdates: [],
      followUpPrompt: issuesFound ? summary : null,
    }
  }

  const jsonText = (lines[jsonLineIndex] ?? '').slice(REVIEW_JSON_PREFIX.length).trim()
  try {
    const parsed = JSON.parse(jsonText) as {
      issuesFound?: boolean
      requestFollowUp?: boolean
      todoUpdates?: TodoUpdateInput[]
      followUpPrompt?: string
    }
    const todoUpdates = Array.isArray(parsed.todoUpdates) ? parsed.todoUpdates : []
    const issuesFound = parsed.issuesFound === true
    const requestFollowUp =
      parsed.requestFollowUp === true || (parsed.requestFollowUp !== false && issuesFound)
    return {
      summary: summary || '(no review output)',
      issuesFound,
      requestFollowUp,
      todoUpdates,
      followUpPrompt:
        typeof parsed.followUpPrompt === 'string' && parsed.followUpPrompt.trim()
          ? parsed.followUpPrompt.trim()
          : null,
    }
  } catch {
    return {
      summary,
      issuesFound: true,
      requestFollowUp: true,
      todoUpdates: [],
      followUpPrompt: summary,
    }
  }
}

const MAX_DIFF_CHARS = 12_000

/** Plan block for the read-only review subagent (includes ids for merge patches). */
export function formatTodosForReviewPrompt(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return ''
  const plan = todos.map((t) => `- [${t.status}] ${t.content} (id: ${t.id})`).join('\n')
  return `\n\n## Task plan to verify\n${plan}\n\nCompare the plan against the diff and parent work. Mark items completed only when the change set supports it; leave items open when work is missing.`
}

/** Build the review subagent's seed prompt from the parent goal, plan, and diff. */
export function buildReviewPrompt(
  parentGoal: string,
  diff: string,
  todos: readonly TodoItem[] = [],
): string {
  const trimmedDiff = diff.trim()
  const diffBlock =
    trimmedDiff.length > MAX_DIFF_CHARS
      ? `${trimmedDiff.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated; use git_diff on specific files for the rest)`
      : trimmedDiff || '(git reported no textual diff; use git_status / staged_diffs to inspect.)'

  return [
    `Parent task: ${parentGoal}`,
    formatTodosForReviewPrompt(todos),
    '',
    'Review the changes the parent agent just made. Working diff:',
    '',
    '```diff',
    diffBlock,
    '```',
    '',
    'Inspect the diff (and read surrounding code as needed), verify the task plan if present, then return your review verdict with the REVIEW_JSON line.',
  ].join('\n')
}
