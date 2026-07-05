import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  getBackgroundProcessLogs,
  listBackgroundProcesses,
  startBackgroundProcess,
  stopBackgroundProcess,
  type BackgroundProcessInfo,
} from '../services/exec/background-process.ts'

function formatInfo(info: BackgroundProcessInfo): string {
  const state = info.running
    ? info.url
      ? `running at ${info.url}`
      : 'running (no URL detected yet)'
    : `exited${info.exitCode !== null ? ` (code ${String(info.exitCode)})` : ''}`
  return `[${info.id}] ${info.command} — ${state}`
}

/** Trim logs so a chatty server doesn't dominate the tool result. */
function tailLogs(logs: string, maxLines = 40): string {
  const lines = logs.split('\n')
  if (lines.length <= maxLines) return logs
  return ['[…]', ...lines.slice(lines.length - maxLines)].join('\n')
}

export const devServerTool = defineTool({
  name: 'dev_server',
  description:
    'Start and manage a long-lived local dev server (e.g. `npm run dev`, `vite`, `python -m http.server`) that stays alive across turns. Actions: `start` a command (returns a handle and the detected http://localhost:<port> URL — open it with browser_navigate); `list` running servers; `logs` for a server by id; `stop` a server by id. Starting a server prompts for permission the first time per project.',
  parameters: z.object({
    action: z.enum(['start', 'list', 'logs', 'stop']),
    command: z
      .string()
      .optional()
      .describe('For action=start: the server command, e.g. "npm run dev".'),
    id: z.string().optional().describe('For action=logs/stop: the server handle from start/list.'),
  }),
  async execute({ action, command, id }) {
    if (action === 'list') {
      const servers = listBackgroundProcesses()
      if (servers.length === 0) return 'No background servers running.'
      return servers.map(formatInfo).join('\n')
    }

    if (action === 'logs') {
      if (!id) return 'dev_server logs requires an id.'
      const logs = getBackgroundProcessLogs(id)
      if (logs === null) return `No background server with id "${id}".`
      return logs.trim() || '(no output yet)'
    }

    if (action === 'stop') {
      if (!id) return 'dev_server stop requires an id.'
      return stopBackgroundProcess(id) ? `Stopped ${id}.` : `No background server with id "${id}".`
    }

    // action === 'start'
    if (!command?.trim()) return 'dev_server start requires a command.'
    const info = await startBackgroundProcess({ command })
    const lines = [formatInfo(info)]
    if (!info.running) {
      const logs = getBackgroundProcessLogs(info.id)
      lines.push('', 'The server exited immediately. Recent output:', tailLogs(logs ?? ''))
    } else if (info.url) {
      lines.push('', `Open it with browser_navigate → ${info.url}`)
    } else {
      lines.push(
        '',
        'No URL detected yet — check `dev_server logs` with this id once it finishes starting.',
      )
    }
    return lines.join('\n')
  },
})
