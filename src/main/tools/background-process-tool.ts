import { z } from 'zod'
import { defineTool } from '@shared/types'
import type { BackgroundProcessInfo } from '@shared/types/background.ts'
import {
  getBackgroundProcessLogs,
  listBackgroundProcesses,
  startBackgroundProcess,
  stopBackgroundProcess,
} from '../services/exec/background-process.ts'

function formatInfo(info: BackgroundProcessInfo): string {
  const state = info.running
    ? info.url
      ? `running at ${info.url}`
      : 'running'
    : `exited${info.exitCode !== null ? ` (code ${String(info.exitCode)})` : ''}`
  return `[${info.id}] ${info.command} — ${state}`
}

/** Trim logs so a chatty process doesn't dominate the tool result. */
function tailLogs(logs: string, maxLines = 40): string {
  const lines = logs.split('\n')
  if (lines.length <= maxLines) return logs
  return ['[…]', ...lines.slice(lines.length - maxLines)].join('\n')
}

export const runBackgroundTool = defineTool({
  name: 'run_background',
  description:
    'Run a long-lived command in the background (dev server, watcher, build) that stays alive across turns. Actions: `start` a command; `list` running tasks; `logs` for a task by id; `stop` a task by id. Set `allow_port_binding: true` for a task that must bind a local port (e.g. a dev server) — it returns the detected http://localhost:<port> URL to open with browser_navigate, and prompts for permission the first time per project. Without it the task runs fully sandboxed (workspace-only, no network/binding).',
  parameters: z.object({
    action: z.enum(['start', 'list', 'logs', 'stop']),
    command: z
      .string()
      .optional()
      .describe('For action=start: the command, e.g. "npm run dev" or "npm run build -- --watch".'),
    allow_port_binding: z
      .boolean()
      .optional()
      .describe('For action=start: allow the task to bind a loopback port (dev servers).'),
    id: z.string().optional().describe('For action=logs/stop: the task handle from start/list.'),
  }),
  async execute({ action, command, allow_port_binding, id }) {
    if (action === 'list') {
      const tasks = listBackgroundProcesses()
      if (tasks.length === 0) return 'No background tasks running.'
      return tasks.map(formatInfo).join('\n')
    }

    if (action === 'logs') {
      if (!id) return 'run_background logs requires an id.'
      const logs = getBackgroundProcessLogs(id)
      if (logs === null) return `No background task with id "${id}".`
      return logs.trim() || '(no output yet)'
    }

    if (action === 'stop') {
      if (!id) return 'run_background stop requires an id.'
      return stopBackgroundProcess(id) ? `Stopped ${id}.` : `No background task with id "${id}".`
    }

    // action === 'start'
    if (!command?.trim()) return 'run_background start requires a command.'
    const info = await startBackgroundProcess({
      command,
      allowPortBinding: allow_port_binding === true,
    })
    const lines = [formatInfo(info)]
    if (!info.running) {
      const logs = getBackgroundProcessLogs(info.id)
      lines.push('', 'The task exited immediately. Recent output:', tailLogs(logs ?? ''))
    } else if (info.url) {
      lines.push('', `Open it with browser_navigate → ${info.url}`)
    } else if (allow_port_binding) {
      lines.push(
        '',
        'No URL detected yet — check `run_background logs` with this id once it finishes starting.',
      )
    }
    return lines.join('\n')
  },
})
