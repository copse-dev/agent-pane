import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import type { MachineAgentDispatchRequest, MachineDispatchResult } from '../agent-dispatcher.ts'
import { abortAgent } from '../agent-service.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { getSetting } from '../storage/settings.ts'
import { resolveSshExecutionTargetForCwd } from '../ssh-workspace/execution-target.ts'
import {
  resolveThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context.ts'
import type { SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'
import type { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { getCiWatchStatus, type CiStatus } from './github-ci-service.ts'

export const CI_WATCH_HANDLER = 'ci_watch'

const ciWatchInputSchema = z.object({
  v: z.literal(1),
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  expiresAt: z.number().int(),
  pollIntervalMs: z.number().int().min(5_000),
  consecutiveErrors: z.number().int().nonnegative(),
})

export type CiWatchInput = z.infer<typeof ciWatchInputSchema>

export interface ScheduleCiWatchRequest {
  context: ThreadExecutionContext
  turnTreeId: TurnTreeId
  prNumber?: number
  timeoutMs: number
  pollIntervalMs: number
}

export interface ScheduleCiWatchResult {
  status: CiStatus
  watching: boolean
  taskId?: string
}

type CiWatchScheduler = (request: ScheduleCiWatchRequest) => Promise<ScheduleCiWatchResult>

let scheduler: CiWatchScheduler | null = null

export function setCiWatchScheduler(next: CiWatchScheduler | null): void {
  scheduler = next
}

export function scheduleCiWatch(request: ScheduleCiWatchRequest): Promise<ScheduleCiWatchResult> {
  if (!scheduler) return Promise.reject(new Error('CI watch scheduling is unavailable'))
  return scheduler(request)
}

export interface CiWatchDispatcher {
  dispatchMachine(request: MachineAgentDispatchRequest): Promise<MachineDispatchResult>
}

export interface CiWatchDependencies {
  readStatus: (prNumber: number | undefined, cwd: string) => Promise<CiStatus>
  resolveContext: (projectId: string, threadId: string) => Promise<ThreadExecutionContext>
  autoRunSandboxCommands: () => boolean
  projectSandboxEnabled: () => boolean
  workspaceTarget: (executionRoot: string) => { kind: 'local' | 'ssh'; id?: string }
  now: () => number
  abortThread: (threadId: string) => void
}

const defaultDependencies: CiWatchDependencies = {
  readStatus: getCiWatchStatus,
  resolveContext: resolveThreadExecutionContext,
  autoRunSandboxCommands: () => getSetting<boolean>('autoRunSandboxCommands', true),
  projectSandboxEnabled: isProjectSandboxEnabled,
  workspaceTarget: (executionRoot) => {
    const target = resolveSshExecutionTargetForCwd(executionRoot)
    return target?.kind === 'ssh' ? { kind: 'ssh', id: target.hostId } : { kind: 'local' }
  },
  now: Date.now,
  abortThread: abortAgent,
}

function parseWatch(task: SupervisedTaskMeta): CiWatchInput | null {
  const parsed = ciWatchInputSchema.safeParse(task.handlerInput)
  return parsed.success ? parsed.data : null
}

function stableWatchInput(input: CiWatchInput): Omit<CiWatchInput, 'consecutiveErrors'> {
  const { consecutiveErrors: _consecutiveErrors, ...stable } = input
  return stable
}

function watchIdentity(context: ThreadExecutionContext, input: CiWatchInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        context.projectId,
        context.threadId,
        context.root,
        context.checkoutMode,
        context.branch,
        stableWatchInput(input),
      ]),
    )
    .digest('hex')
}

function ciResultPrompt(status: CiStatus, input: CiWatchInput, outcome: string): string {
  const failed = status.checks.filter((check) => check.bucket === 'fail').map((check) => check.name)
  const checkSummary = failed.length > 0 ? ` Failed checks: ${failed.join(', ')}.` : ''
  return `The durable CI watch for pull request #${String(input.prNumber)} changed: ${outcome}.${checkSummary}\nWatched head: ${input.headSha}. Current head: ${status.headSha ?? '(unavailable)'}.\nContinue the original task now. Re-read CI status first. If CI failed, inspect the failed logs, diagnose the root cause, fix it, run the relevant local verification, and report what changed. If CI passed, finish any remaining pull-request work and report the result.`
}

function dispatchResultRef(result: MachineDispatchResult): { kind: 'handler'; ref: string } {
  return { kind: 'handler', ref: `agent-dispatch:${result}` }
}

function pollDelay(input: CiWatchInput): number {
  const exponent = Math.min(input.consecutiveErrors, 4)
  return Math.min(input.pollIntervalMs * 2 ** exponent, 15 * 60_000)
}

function isTerminalStatus(status: CiStatus): boolean {
  return status.overall === 'success' || status.overall === 'failure'
}

export function installCiWatchConsumer(
  supervisor: TaskSupervisor,
  dispatcher: CiWatchDispatcher,
  dependencies: CiWatchDependencies = defaultDependencies,
): () => void {
  const unregister = supervisor.registerHandler(CI_WATCH_HANDLER, async (task, { signal }) => {
    signal.throwIfAborted()
    const input = parseWatch(task)
    if (!input) return { blockedReason: 'CI watch has invalid persisted input' }
    if (!task.turnId) return { blockedReason: 'CI watch is missing its turn-tree epoch' }

    let context: ThreadExecutionContext
    try {
      context = await dependencies.resolveContext(task.projectId, task.threadId)
    } catch (error) {
      return {
        blockedReason:
          error instanceof Error ? error.message : 'Thread execution context is unavailable',
      }
    }
    const target = dependencies.workspaceTarget(context.root)
    const snapshot = task.permissionSnapshot
    const permissionsChanged =
      snapshot.autoRunSandboxCommands !== dependencies.autoRunSandboxCommands() ||
      snapshot.projectSandboxEnabled !== dependencies.projectSandboxEnabled() ||
      snapshot.workspaceTargetKind !== target.kind ||
      snapshot.workspaceTargetId !== target.id ||
      snapshot.executionRoot !== context.root
    if (permissionsChanged || task.contentHash !== watchIdentity(context, input)) {
      return {
        blockedReason: 'Execution permissions, workspace, or CI watch changed after scheduling',
      }
    }
    if (task.reapproveOnWake) {
      return { blockedReason: 'CI watch requires explicit approval before dispatch' }
    }

    let status: CiStatus
    let statusReadFailed = false
    try {
      status = await dependencies.readStatus(input.prNumber, context.root)
    } catch (error) {
      const now = dependencies.now()
      if (now >= input.expiresAt) {
        statusReadFailed = true
        status = {
          prNumber: input.prNumber,
          prTitle: null,
          prUrl: null,
          branch: null,
          headSha: input.headSha,
          overall: 'no_checks',
          checks: [],
          latestRunId: null,
          latestRunUrl: null,
        }
      } else {
        const nextInput: CiWatchInput = {
          ...input,
          consecutiveErrors: input.consecutiveErrors + 1,
        }
        return {
          reschedule: {
            trigger: { kind: 'wake_at', wakeAt: now + pollDelay(nextInput) },
            handlerInput: nextInput,
            reason: `CI status read failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        }
      }
    }

    const now = dependencies.now()
    const headChanged = status.headSha !== null && status.headSha !== input.headSha
    const prUnavailable = status.prUrl === null
    const expired = now >= input.expiresAt
    if (!isTerminalStatus(status) && !headChanged && !prUnavailable && !expired) {
      const nextInput: CiWatchInput = { ...input, consecutiveErrors: 0 }
      return {
        resultRef: { kind: 'handler', ref: `ci:${status.overall}` },
        reschedule: {
          trigger: { kind: 'wake_at', wakeAt: now + input.pollIntervalMs },
          handlerInput: nextInput,
          reason: `CI remains ${status.overall}`,
        },
      }
    }

    const outcome = statusReadFailed
      ? 'the watch expired and the final CI status could not be read'
      : headChanged
        ? 'the pull request head changed'
        : prUnavailable
          ? 'the pull request is no longer open or available'
          : isTerminalStatus(status)
            ? `CI is ${status.overall}`
            : `the watch expired while CI was ${status.overall}`
    signal.throwIfAborted()
    const abort = (): void => {
      dependencies.abortThread(task.threadId)
    }
    signal.addEventListener('abort', abort, { once: true })
    let result: MachineDispatchResult
    try {
      result = await dispatcher.dispatchMachine({
        projectId: task.projectId,
        threadId: task.threadId,
        operationId: task.taskId,
        turnTreeId: task.turnId,
        payload: {
          userContent: ciResultPrompt(status, input, outcome),
          invokedSkills: [],
          priorTodos: [],
        },
      })
    } finally {
      signal.removeEventListener('abort', abort)
    }
    if (result === 'stale') return { blockedReason: 'CI watch belongs to a stale turn-tree epoch' }
    if (result === 'budget-exhausted') {
      return { blockedReason: 'CI watch exhausted the machine-continuation budget' }
    }
    return { resultRef: dispatchResultRef(result) }
  })

  setCiWatchScheduler(async ({ context, turnTreeId, prNumber, timeoutMs, pollIntervalMs }) => {
    const status = await dependencies.readStatus(prNumber, context.root)
    if (status.prNumber === null || status.prUrl === null || status.headSha === null) {
      throw new Error('No open pull request with a head commit was found for this branch')
    }
    if (isTerminalStatus(status)) return { status, watching: false }

    const existing = supervisor.list(context.projectId).find((task) => {
      if (
        task.threadId !== context.threadId ||
        task.handler !== CI_WATCH_HANDLER ||
        (task.state !== 'queued' && task.state !== 'waiting' && task.state !== 'running')
      ) {
        return false
      }
      const watch = parseWatch(task)
      return watch?.prNumber === status.prNumber && watch.headSha === status.headSha
    })
    if (existing) return { status, watching: true, taskId: existing.taskId }

    const now = dependencies.now()
    const input: CiWatchInput = {
      v: 1,
      prNumber: status.prNumber,
      headSha: status.headSha,
      expiresAt: now + timeoutMs,
      pollIntervalMs,
      consecutiveErrors: 0,
    }
    const target = dependencies.workspaceTarget(context.root)
    const task = await supervisor.enqueue({
      projectId: context.projectId,
      threadId: context.threadId,
      handler: CI_WATCH_HANDLER,
      handlerInput: input,
      provenance: 'agent',
      trigger: { kind: 'wake_at', wakeAt: now + pollIntervalMs },
      permissionSnapshot: {
        capturedAt: now,
        autoRunSandboxCommands: dependencies.autoRunSandboxCommands(),
        projectSandboxEnabled: dependencies.projectSandboxEnabled(),
        workspaceTargetKind: target.kind,
        ...(target.id ? { workspaceTargetId: target.id } : {}),
        executionRoot: context.root,
      },
      reapproveOnWake: false,
      concurrencyClass: 'network',
      maxAttempts: 1,
      contentHash: watchIdentity(context, input),
      turnId: turnTreeId,
    })
    return { status, watching: true, taskId: task.taskId }
  })

  void (async (): Promise<void> => {
    await supervisor.start()
    const persisted = supervisor
      .list()
      .filter((task) => task.handler === CI_WATCH_HANDLER && task.state === 'waiting')
    await Promise.all(
      persisted.map((task) => supervisor.wake(task.projectId, task.taskId, 'CI startup reconcile')),
    )
  })().catch((error: unknown) => {
    console.error('[ci-watch] Startup reconciliation failed:', error)
  })

  return () => {
    setCiWatchScheduler(null)
    unregister()
  }
}
