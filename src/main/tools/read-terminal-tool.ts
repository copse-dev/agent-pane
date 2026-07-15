import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  READ_TERMINAL_DEFAULT_LINES,
  READ_TERMINAL_MAX_LINES,
} from '@shared/terminal/read-terminal.ts'
import { getActiveRunThread } from '../services/thread-models.ts'
import {
  listTerminalSessions,
  readTerminalSessionOutput,
} from '../services/exec/terminal-service.ts'

function formatListLine(info: { id: string; label: string; active: boolean }): string {
  const mark = info.active ? ' (active)' : ''
  return `- ${info.label}${mark} [id=${info.id}]`
}

/**
 * Read the user's integrated Shells tabs (not agent `run_shell` tasks).
 * Only offered while at least one shell is open for the current thread.
 */
export const readTerminalTool = defineTool({
  name: 'read_terminal',
  description:
    "Read output from the user's open Shells tabs (interactive terminals in the right panel), not agent-run commands. Actions: `list` open shells for this chat; `read` recent scrollback (defaults to the active tab). Pass `id` from list to pick a tab; `max_lines` (default 200, max 2000) to control how much history to pull — use a smaller window for a quick check, or a larger one / hand the result to a subagent when the log is noisy. Prefer this over asking the user to paste when a shell is already open. Users can also `@shell` a tab into chat explicitly.",
  parameters: z.object({
    action: z
      .enum(['list', 'read'])
      .optional()
      .default('read')
      .describe('list open shells, or read scrollback from one.'),
    id: z
      .string()
      .optional()
      .describe('Session id from list. Omit on read to use the active (focused) shell.'),
    max_lines: z
      .number()
      .int()
      .min(1)
      .max(READ_TERMINAL_MAX_LINES)
      .optional()
      .default(READ_TERMINAL_DEFAULT_LINES)
      .describe(`How many trailing lines to return (1–${String(READ_TERMINAL_MAX_LINES)}).`),
  }),
  execute({ action, id, max_lines }) {
    const threadId = getActiveRunThread()
    if (action === 'list') {
      const shells = listTerminalSessions(threadId)
      if (shells.length === 0) {
        return 'No open Shells tabs for this chat. The user can open one from the Shells panel.'
      }
      return ['Open shells:', ...shells.map(formatListLine)].join('\n')
    }

    const snap = readTerminalSessionOutput(id, max_lines, threadId)
    if (!snap) {
      if (id) return `No open shell with id "${id}" for this chat.`
      return 'No open Shells tabs for this chat. The user can open one from the Shells panel.'
    }
    const body = snap.text.trim() ? snap.text : '(no output yet)'
    return `Shell "${snap.label}" [${snap.id}]\n\n${body}`
  },
})
