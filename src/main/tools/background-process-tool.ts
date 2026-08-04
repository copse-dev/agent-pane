import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  getBackgroundProcessLogs,
  listBackgroundProcesses,
  type BackgroundProcessInfo,
} from '../services/exec/background-process.ts'
import {
  startSupervisedBackgroundProcess,
  stopSupervisedBackgroundProcess,
} from '../services/exec/supervised-background-process.ts'
import { requestBackgroundCompletionWake } from '../services/exec/background-completion-wake.ts'
import { requireThreadExecutionOwner } from '../services/thread-execution-context.ts'
import { getActiveRunTurnTreeId } from '../services/thread-models.ts'

function formatInfo(info: BackgroundProcessInfo): string {
  const containment = info.unsandboxed ? ' · unsandboxed' : ''
  const state = info.running
    ? info.url
      ? info.urlRemote
        ? `running at ${info.url} (remote host)`
        : `running at ${info.url}`
      : 'running'
    : info.timedOut
      ? 'timed out'
      : `exited${info.exitCode !== null ? ` (code ${String(info.exitCode)})` : ''}`
  return `[${info.id}] ${info.command} — ${state}${containment}`
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
    'Run a long-lived command in the background (dev server, watcher, build) that stays alive across turns. Actions: `start` a command; `list` running tasks; `logs` for a task by id; `stop` a task by id. Set `allow_port_binding: true` for a task that must bind a local port (e.g. a dev server) — it returns the detected http://localhost:<port> URL to open with browser_navigate, and prompts for permission the first time per project. For a bounded task that should wake the agent when it exits, set `wake_on_completion: true` and `timeout_ms`; after it starts, end the turn instead of polling because completion will resume the task. Without port binding it runs fully sandboxed (workspace-only, no network/binding).',
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
    wake_on_completion: z
      .boolean()
      .optional()
      .describe('For action=start: wake this agent task once when the process exits.'),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 60 * 1_000)
      .optional()
      .describe('Required with wake_on_completion: hard deadline in milliseconds.'),
    id: z.string().optional().describe('For action=logs/stop: the task handle from start/list.'),
  }),
  async execute({ action, command, allow_port_binding, wake_on_completion, timeout_ms, id }) {
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
      const owner = requireThreadExecutionOwner()
      return (await stopSupervisedBackgroundProcess(id, owner))
        ? `Stopped ${id}.`
        : `No background task with id "${id}".`
    }

    // action === 'start'
    if (!command?.trim()) return 'run_background start requires a command.'
    if (wake_on_completion === true && timeout_ms === undefined) {
      return 'run_background start with wake_on_completion requires timeout_ms.'
    }
    const owner = requireThreadExecutionOwner()
    const turnTreeId = wake_on_completion === true ? getActiveRunTurnTreeId() : null
    if (wake_on_completion === true && !turnTreeId) {
      return 'run_background cannot wake without an active human turn-tree.'
    }
    const info = await startSupervisedBackgroundProcess({
      command,
      allowPortBinding: allow_port_binding === true,
      owner,
      ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
      ...(turnTreeId
        ? {
            onCompletion: async ({ info: completed }): Promise<void> => {
              await requestBackgroundCompletionWake({
                operationId: completed.id,
                owner,
                turnTreeId,
                exitCode: completed.exitCode,
                timedOut: completed.timedOut,
              })
            },
          }
        : {}),
    })
    const lines = [formatInfo(info)]
    if (!info.running) {
      const logs = getBackgroundProcessLogs(info.id)
      lines.push('', 'The task exited immediately. Recent output:', tailLogs(logs ?? ''))
    } else if (wake_on_completion === true) {
      lines.push('', 'Completion wake is armed. End this turn now; do not poll for completion.')
    } else if (info.url) {
      if (info.urlRemote) {
        lines.push(
          '',
          `Server listening at ${info.url} on the remote host (port forwarding is not available yet — tunnels are tracked in issue #771).`,
        )
      } else {
        lines.push('', `Open it with browser_navigate → ${info.url}`)
      }
    } else if (allow_port_binding) {
      lines.push(
        '',
        'No URL detected yet — check `run_background logs` with this id once it finishes starting.',
      )
    }
    return lines.join('\n')
  },
})
