import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  getBackgroundProcessLogs,
  backgroundSandboxRetryReasons,
  claimBackgroundSandboxRetry,
  isBackgroundExitObserved,
  listBackgroundProcesses,
  type BackgroundProcessInfo,
} from '../services/exec/background-process.ts'
import {
  startSupervisedBackgroundProcess,
  stopSupervisedBackgroundProcess,
} from '../services/exec/supervised-background-process.ts'
import {
  requestBackgroundCompletionWake,
  resolveBackgroundCompletionWakeHandler,
} from '../services/exec/background-completion-wake.ts'
import {
  isThreadCheckoutDeferred,
  requireThreadExecutionOwner,
} from '../services/thread-execution-context.ts'
import { currentAgentRoots, getAgentExecutionRoot } from '../services/execution-root.ts'
import { isProjectSandboxEnabled } from '../project-sandbox/enabled.ts'
import { spawnRunsOnSshTarget } from '../project-sandbox/spawn.ts'
import { shellRunsOutsideSandbox } from '../services/security/command-routing-config.ts'
import { shellExpectedBlockEscalation } from '../services/security/permission-policy.ts'
import {
  promptExpectedSandboxBlock,
  promptUnsandboxedShell,
} from '../services/security/permission-gate.ts'
import { resolveToolPermission } from '../services/security/tool-permissions.ts'
import { currentRunIsUnattendedContainer } from '../services/security/unattended-run.ts'
import { getActiveRunTurnTreeId } from '../services/thread-models.ts'
import {
  captureLateCommandPhaseReport,
  reportCommandPhase,
} from '../services/exec/command-phase.ts'

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

function retryAdvice(info: BackgroundProcessInfo): string {
  if (!backgroundSandboxRetryReasons(info.id, info.command, info.cwd)) return ''
  return (
    '\nA sandbox denial may have caused this failure. Inspect partial effects before replaying. ' +
    'To request a new outside attempt, call run_background with action=start, the exact same command, ' +
    `and retry_of="${info.id}". Fresh consent is required; the failed task is not restarted automatically.`
  )
}

export const runBackgroundTool = defineTool({
  name: 'run_background',
  description:
    'Run a command asynchronously with a durable task handle. Use this for long-lived commands (dev servers and watchers) and bounded work expected to outlive a foreground call or leave you waiting (long builds, test suites, evals, data generation, migrations, and similar jobs). Actions: `start` a command; `list` running tasks; `logs` for a task by id; `stop` a task by id. Set `allow_port_binding: true` for a task that must bind a local port (e.g. a dev server) — it returns the detected http://localhost:<port> URL to open with browser_navigate, and prompts for permission the first time per project. For bounded work, set `wake_on_completion: true` and `timeout_ms`; after it starts, end the turn instead of polling because completion will resume the task exactly once. Local commands use the project sandbox; commands approved for outside access use the same routing as run_shell. A read-access approval widens only the named paths. Use expects_sandbox_block to request an escape before an ambiguous command, or retry_of with the exact command of a failed contained task to request a new outside attempt. Inspect partial effects before retrying. Neither option authorizes access without consent.',
  parameters: z.object({
    action: z.enum(['start', 'list', 'logs', 'stop']),
    command: z
      .string()
      .optional()
      .describe('For action=start: the command, e.g. "npm run dev" or "npm run build -- --watch".'),
    expects_sandbox_block: z
      .boolean()
      .optional()
      .describe(
        'For action=start: ask before an ambiguous command expected to need outside access. Declining keeps it contained.',
      ),
    retry_of: z
      .string()
      .optional()
      .describe(
        'For action=start: failed contained task id to retry once with fresh outside consent and the exact same command. Inspect partial effects first.',
      ),
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
  async execute(
    {
      action,
      command,
      allow_port_binding,
      wake_on_completion,
      timeout_ms,
      id,
      expects_sandbox_block,
      retry_of,
    },
    signal,
  ) {
    if (action === 'list') {
      const tasks = listBackgroundProcesses()
      if (tasks.length === 0) return 'No background tasks running.'
      return tasks.map(formatInfo).join('\n')
    }

    if (action === 'logs') {
      if (!id) return 'run_background logs requires an id.'
      const logs = getBackgroundProcessLogs(id)
      if (logs === null) return `No background task with id "${id}".`
      const output = logs.trim() || '(no output yet)'
      const info = listBackgroundProcesses().find((task) => task.id === id)
      return info && !info.running ? `${formatInfo(info)}\n\n${output}${retryAdvice(info)}` : output
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
    signal.throwIfAborted()
    const cwd = getAgentExecutionRoot()
    if (!cwd) return 'No workspace open.'
    let unsandboxed = false
    let suppressSandboxRetry = false
    if (retry_of !== undefined) {
      if (isThreadCheckoutDeferred() || currentRunIsUnattendedContainer(owner.threadId)) {
        return 'An outside background retry is unavailable in this execution mode.'
      }
      const reasons = backgroundSandboxRetryReasons(retry_of, command, cwd, owner)
      if (!reasons)
        return 'No eligible failed contained task matches retry_of, command, owner and working directory.'
      const approved = await promptUnsandboxedShell(
        command,
        ['This starts a new attempt; the failed task may have made partial changes.', ...reasons],
        signal,
        // One outside attempt only: a forged denial must not earn a standing grant.
        { requireInteractiveApproval: true, oneShot: true },
      )
      signal.throwIfAborted()
      if (!approved) return 'Outside background retry declined; no new attempt was started.'
      if (resolveToolPermission('run_background')?.policy === 'block')
        throw new Error('This tool is blocked.')
      if (!claimBackgroundSandboxRetry(retry_of, command, cwd, owner))
        return 'The failed task is no longer eligible for retry.'
      unsandboxed = true
    } else if (
      expects_sandbox_block === true &&
      !isThreadCheckoutDeferred() &&
      !currentRunIsUnattendedContainer(owner.threadId) &&
      !spawnRunsOnSshTarget(cwd) &&
      !shellRunsOutsideSandbox(command, currentAgentRoots(), 'run_background')
    ) {
      const escalation = shellExpectedBlockEscalation(command, cwd, isProjectSandboxEnabled())
      if (escalation.eligible) {
        unsandboxed = await promptExpectedSandboxBlock(command, escalation.reasons, signal, {
          executionRoot: cwd,
          requireInteractiveApproval: true,
        })
        suppressSandboxRetry = !unsandboxed
      }
    }
    signal.throwIfAborted()
    if (resolveToolPermission('run_background')?.policy === 'block')
      throw new Error('This tool is blocked.')
    // Capture before spawn: process `exit` is delivered outside this ALS scope.
    const armedWakeHandler = turnTreeId === null ? null : resolveBackgroundCompletionWakeHandler()
    // The task ends after this call returns, often in a later turn: record its
    // end on the card that started it before any wake reads that card (#3956).
    const reportEnd = captureLateCommandPhaseReport(owner)
    reportCommandPhase('starting')
    const info = await startSupervisedBackgroundProcess({
      command,
      cwd,
      unsandboxed,
      suppressSandboxRetry,
      allowPortBinding: allow_port_binding === true,
      owner,
      ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
      onCancelled: ({ id: taskId }) => {
        void reportEnd('cancelled', { backgroundTaskId: taskId })
      },
      onCompletion: async ({ info: completed }): Promise<void> => {
        await reportEnd(completed.timedOut ? 'timed_out' : 'exited', {
          backgroundTaskId: completed.id,
          ...(completed.exitCode !== null ? { exitCode: completed.exitCode } : {}),
        })
        if (!turnTreeId) return
        await requestBackgroundCompletionWake(
          {
            operationId: completed.id,
            owner,
            turnTreeId,
            exitCode: completed.exitCode,
            timedOut: completed.timedOut,
            alreadyObserved: () => isBackgroundExitObserved(completed.id, owner),
          },
          armedWakeHandler,
        )
      },
    })
    reportCommandPhase('running', { backgroundTaskId: info.id })
    if (!info.running) {
      reportCommandPhase(info.timedOut ? 'timed_out' : 'exited', {
        backgroundTaskId: info.id,
        ...(info.exitCode !== null ? { exitCode: info.exitCode } : {}),
      })
    }
    const lines = [formatInfo(info)]
    if (!info.running) {
      const logs = getBackgroundProcessLogs(info.id)
      lines.push('', 'The task exited immediately. Recent output:', tailLogs(logs ?? ''))
      lines.push(retryAdvice(info))
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
