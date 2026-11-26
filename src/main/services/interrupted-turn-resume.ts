import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message, Thread } from '@shared/types'
import type { MachineDispatchResult } from '@shared/types/machine-dispatch.ts'
import { explicitAgentForMessage } from '@shared/threads/explicit-agent.ts'
import { INTERRUPTED_TURN_CONTINUATION } from '@shared/turn-recovery.ts'
import type { MachineAgentDispatchRequest } from './agent-dispatcher.ts'
import { listRunningThreadIds } from './agent-service.ts'
import { previousRun, previousRunAllowsResume, type LastRunRecord } from './last-run.ts'
import { storageGet } from './storage/storage.ts'
import { loadAgentTurnEpoch, loadProjectThreadMetas, loadThreadMessages } from './thread-store.ts'

/**
 * Continue the turns a quit, an update relaunch or a crash cut off.
 *
 * A turn lives in the main process, so ending the process ends the turn. Its
 * transcript and provider history are already on disk (main writes both as the
 * turn runs), and the thread is left `running` there because nothing settled it.
 * On the next launch this finds those threads and dispatches one machine
 * continuation for each, with the same fixed prompt the "Continue" recovery
 * button sends. It goes through `dispatchMachine`, so it is charged to the
 * thread's turn tree like any other machine-initiated turn and is refused when
 * the tree is stale or its continuation budget is spent (hooks plan decision 5).
 *
 * It continues only what the previous run of this profile left running, and only
 * when that run crashed or was relaunched by the updater (`last-run.ts`). A quit
 * the user chose stops the run, as the close dialog says; those threads keep the
 * usual "Continue" card. A thread last touched before the previous run started
 * was cut off longer ago, and is left alone too.
 *
 * Each continuation runs on the thread's own model, reasoning level and
 * execution mode, as the "Continue" button would send them
 * (`refreshAgentRunPayload`); otherwise a thread on an ACP or remote agent would
 * be continued by the Settings default.
 *
 * It resumes once per interruption. A thread whose newest prompt is already a
 * restart continuation was cut off again while resuming, so it is left for the
 * user to continue by hand, which keeps a turn that crashes the app from
 * relaunching itself in a loop.
 */

/** Operation ids this module dispatches start with this, so a repeat can be recognised. */
export const RESTART_RESUME_OPERATION_PREFIX = 'restart-resume:'

/** What the user sees in the transcript where the continuation starts. */
export const RESTART_RESUME_DISPLAY =
  'Copse restarted during this turn. Continuing where it stopped.'

type ResumeThreadMeta = Pick<
  Thread,
  | 'id'
  | 'status'
  | 'interruptedTurnAt'
  | 'archivedAt'
  | 'sideChat'
  | 'automation'
  | 'pendingMessages'
  | 'todos'
  | 'workingBrief'
  | 'updatedAt'
  | 'model'
  | 'reasoning'
  | 'executionMode'
>

/**
 * Whether a thread's persisted state says its turn was cut off by the last exit.
 *
 * `running` on disk with no live run is the direct sign. The window may get there
 * first on this launch and settle the thread to idle with `interruptedTurnAt`
 * (`resumePendingQueues`), so a stamp from this launch counts too. An older stamp
 * is an interruption the user already saw and chose not to continue.
 */
export function wasInterruptedByExit(thread: ResumeThreadMeta, bootedAt: number): boolean {
  if (thread.archivedAt !== undefined) return false
  // A side chat is a short aside the user drives; a scheduled automation has its
  // own run recovery (`automation-run-recovery.ts`).
  if (thread.sideChat !== undefined || thread.automation !== undefined) return false
  // Queued follow-ups drain when the window loads, which continues the thread
  // anyway; a resume here would race them for the slot.
  if ((thread.pendingMessages?.length ?? 0) > 0) return false
  if (thread.status === 'running') return true
  return thread.interruptedTurnAt !== undefined && thread.interruptedTurnAt >= bootedAt
}

function isRestartResume(message: Message): boolean {
  return (
    message.origin?.kind === 'machine' &&
    message.origin.operationId.startsWith(RESTART_RESUME_OPERATION_PREFIX)
  )
}

/**
 * Whether the transcript ends in a turn that can be continued automatically: the
 * same tail the "Continue" button accepts (`turn-recovery.ts`), and not already a
 * restart continuation.
 */
export function transcriptCanResume(messages: readonly Message[]): boolean {
  const lastIndex = messages.length - 1
  const last = messages[lastIndex]
  if (!last || (last.role !== 'user' && last.role !== 'assistant')) return false
  if (last.turnOutcome !== undefined) return false
  // A `/name` invocation runs a one-shot worker the generic continuation cannot
  // resume; the user retries it explicitly.
  if (explicitAgentForMessage(messages, lastIndex) !== undefined) return false
  for (let index = lastIndex; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    return !isRestartResume(message)
  }
  return true
}

export interface InterruptedTurnResumeDependencies {
  listProjectIds: () => readonly string[]
  loadThreadMetas: (projectId: string) => Promise<readonly ResumeThreadMeta[]>
  loadMessages: (projectId: string, threadId: string) => Promise<readonly Message[]>
  /** The thread's persisted turn tree, or null for a thread that predates epochs. */
  loadTurnTreeId: (projectId: string, threadId: string) => Promise<string | null>
  isRunning: (threadId: string) => boolean
  dispatchMachine: (request: MachineAgentDispatchRequest) => Promise<MachineDispatchResult>
  createId: () => string
  /** When this process started, to tell this launch's interruption stamps from older ones. */
  bootedAt: number
  /** How the previous run ended; nothing is continued without one. */
  previousRun: () => Promise<LastRunRecord | null>
  onError: (error: unknown) => void
}

export interface ResumedTurn {
  projectId: string
  threadId: string
  result: MachineDispatchResult | 'failed'
}

/**
 * Find every thread the last exit cut off and continue it. Dispatches run
 * concurrently (each thread has its own slot); the returned promise settles once
 * every continuation has finished or been refused.
 */
export async function resumeInterruptedTurns(
  deps: InterruptedTurnResumeDependencies,
): Promise<ResumedTurn[]> {
  const dispatches: Promise<ResumedTurn>[] = []
  const previous = await deps.previousRun()
  if (previous === null || !previousRunAllowsResume(previous)) return []
  for (const projectId of deps.listProjectIds()) {
    let threads: readonly ResumeThreadMeta[]
    try {
      threads = await deps.loadThreadMetas(projectId)
    } catch (error) {
      deps.onError(error)
      continue
    }
    for (const thread of threads) {
      if (!wasInterruptedByExit(thread, deps.bootedAt) || deps.isRunning(thread.id)) continue
      // Cut off before the previous run started: not that run's turn.
      if (thread.updatedAt < previous.startedAt) continue
      try {
        if (!transcriptCanResume(await deps.loadMessages(projectId, thread.id))) continue
        const turnTreeId = (await deps.loadTurnTreeId(projectId, thread.id)) ?? thread.id
        // The user may have started something in the meantime.
        if (deps.isRunning(thread.id)) continue
        const threadId = thread.id
        dispatches.push(
          deps
            .dispatchMachine({
              projectId,
              threadId,
              operationId: `${RESTART_RESUME_OPERATION_PREFIX}${deps.createId()}`,
              turnTreeId,
              display: { content: RESTART_RESUME_DISPLAY },
              payload: {
                userContent: INTERRUPTED_TURN_CONTINUATION,
                invokedSkills: [],
                priorTodos: thread.todos ?? [],
                ...(thread.workingBrief !== undefined ? { workingBrief: thread.workingBrief } : {}),
                ...(thread.model !== undefined ? { model: thread.model } : {}),
                ...(thread.reasoning !== undefined ? { reasoning: thread.reasoning } : {}),
                ...(thread.executionMode === 'agent' ? { executionMode: 'agent' as const } : {}),
              },
            })
            .then(
              (result): ResumedTurn => ({ projectId, threadId, result }),
              (error: unknown): ResumedTurn => {
                deps.onError(error)
                return { projectId, threadId, result: 'failed' }
              },
            ),
        )
      } catch (error) {
        deps.onError(error)
      }
    }
  }
  return Promise.all(dispatches)
}

const projectIdsSchema = z.array(z.object({ id: z.string().regex(/^[\w-]{1,128}$/) }))

/** The app's own stores and dispatcher, for the boot-time call. */
export function defaultInterruptedTurnResumeDependencies(dispatcher: {
  dispatchMachine: InterruptedTurnResumeDependencies['dispatchMachine']
}): InterruptedTurnResumeDependencies {
  return {
    listProjectIds: (): string[] => {
      const projects = projectIdsSchema.safeParse(storageGet('projects'))
      return projects.success ? projects.data.map((project) => project.id) : []
    },
    loadThreadMetas: (projectId) => loadProjectThreadMetas(projectId),
    loadMessages: loadThreadMessages,
    loadTurnTreeId: async (projectId, threadId) =>
      (await loadAgentTurnEpoch(projectId, threadId))?.turnTreeId ?? null,
    isRunning: (threadId) => listRunningThreadIds().includes(threadId),
    dispatchMachine: (request) => dispatcher.dispatchMachine(request),
    createId: randomUUID,
    bootedAt: Date.now() - process.uptime() * 1_000,
    previousRun,
    onError: (error): void => {
      console.error('[resume] could not continue an interrupted turn:', error)
    },
  }
}
