import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  getRecentStagedDiffDecision,
  getStagedDiffEntry,
  listRecentStagedDiffDecisions,
  listStagedDiffEntries,
} from '../services/diff-queue.ts'
import { getGitStatus } from '../services/git-service.ts'
import type { GitStatusResult } from '@shared/types/git.ts'

const DEFAULT_MAX_CHARS = 24_000
const MAX_CHARS_LIMIT = 80_000

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[Truncated ${String(text.length - maxChars)} chars]`
}

function firstChangedLine(before: string, after: string): number | null {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let i = 0; i < max; i++) {
    if (beforeLines[i] !== afterLines[i]) return i + 1
  }
  return null
}

function formatGitChanges(status: GitStatusResult | null): string[] {
  if (!status) return ['Git status: unavailable or not a git worktree.']
  const lines = [
    ...status.staged.map((change) => `- staged ${change.status}: ${change.path}`),
    ...status.unstaged.map((change) => `- unstaged ${change.status}: ${change.path}`),
  ]
  return lines.length > 0 ? ['Existing git changes:', ...lines] : ['Existing git changes: none']
}

export const stagedDiffsTool = defineTool({
  name: 'staged_diffs',
  description:
    'List pending Copse staged diffs proposed by write_file/str_replace. These are not git-staged files and are not written to disk until the user approves them.',
  parameters: z.object({}),
  async execute() {
    const entries = listStagedDiffEntries()
    const decisions = listRecentStagedDiffDecisions()
    const gitLines = formatGitChanges(await getGitStatus())
    if (entries.length === 0) {
      const recent =
        decisions.length > 0
          ? `\n\nRecent staged diff decisions this session:\n${decisions
              .slice(0, 10)
              .map((d) => `- ${d.path}: ${d.status}${d.error ? ` (${d.error})` : ''}`)
              .join('\n')}`
          : ''
      return `No pending Copse staged diffs.${recent}\n\n${gitLines.join('\n')}\n\nIf a diff was applied directly or approved, read_file/git_status will show the on-disk result. If it was rejected, no proposed content is retained.`
    }
    const recent =
      decisions.length > 0
        ? [
            '',
            'Recent staged diff decisions this session:',
            ...decisions
              .slice(0, 10)
              .map((d) => `- ${d.path}: ${d.status}${d.error ? ` (${d.error})` : ''}`),
          ]
        : []
    return [
      'Pending Copse staged diffs (not written to disk until user approval):',
      ...entries.map((entry) => {
        const changedLine = firstChangedLine(entry.before, entry.after)
        const changed = changedLine ? `, first changed line ${String(changedLine)}` : ''
        return `- ${entry.path} (${entry.language}${changed}; before ${String(entry.before.length)} chars, proposed after ${String(entry.after.length)} chars)`
      }),
      ...recent,
      '',
      ...gitLines,
      '',
      'Use read_staged_diff with a path to inspect proposed content. Shell commands, git, and read_file still see only the on-disk file until approval.',
    ].join('\n')
  },
})

export const readStagedDiffTool = defineTool({
  name: 'read_staged_diff',
  description:
    'Inspect a pending Copse staged diff for one file. Use this after write_file/str_replace to see proposed content that is not written to disk yet.',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root'),
    view: z
      .enum(['after', 'before', 'both'])
      .optional()
      .default('after')
      .describe('Which content to return. Default "after" is the proposed content.'),
    max_chars: z
      .number()
      .int()
      .min(1000)
      .max(MAX_CHARS_LIMIT)
      .optional()
      .default(DEFAULT_MAX_CHARS)
      .describe('Maximum characters per returned content block.'),
  }),
  execute({ path, view, max_chars }) {
    const entry = getStagedDiffEntry(path)
    if (!entry) {
      const recent = getRecentStagedDiffDecision(path)
      const recentText = recent
        ? ` Most recent staged diff decision for this path: ${recent.status}${recent.error ? ` (${recent.error})` : ''}.`
        : ''
      return `No pending Copse staged diff for ${path}.${recentText} If a previous diff was approved, read_file/git_status will show the on-disk result. If it was rejected, no proposed content is retained.`
    }

    const changedLine = firstChangedLine(entry.before, entry.after)
    const header = [
      `Pending Copse staged diff for ${entry.path}`,
      `Language: ${entry.language}`,
      `First changed line: ${changedLine === null ? 'none' : String(changedLine)}`,
      'Status: pending user approval; not written to disk.',
    ].join('\n')

    if (view === 'before') {
      return `${header}\n\n--- before (on-disk snapshot when staged) ---\n${cap(entry.before, max_chars)}`
    }
    if (view === 'both') {
      return `${header}\n\n--- before (on-disk snapshot when staged) ---\n${cap(entry.before, max_chars)}\n\n--- after (proposed pending content) ---\n${cap(entry.after, max_chars)}`
    }
    return `${header}\n\n--- after (proposed pending content) ---\n${cap(entry.after, max_chars)}`
  },
})
