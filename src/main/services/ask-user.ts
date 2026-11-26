import type { BrowserWindow, IpcMain } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { ASK_USER_TIMEOUT_MS, type AskUserQuestion } from '@copse/agent/ask-user-format.ts'
import type { AskUserActionsPresentation } from '@shared/types/ask-user.ts'
import {
  askRespondSchema,
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
} from '../ipc/ipc-guards.ts'
import { getActiveRunThread } from './thread-models.ts'
import { withRunDeadlinePaused } from './hooks/run-deadline.ts'
import { humanDecisions, humanDecisionSource, humanDecisionActor } from './human-decisions.ts'
import { getThreadExecutionContext } from './thread-execution-context.ts'
import { recordDecision } from './security/decision-log-store.ts'
import type { UserAlertSender } from './user-alerts.ts'
import { isDeferralModeActive } from './security/deferral-mode.ts'

export interface AskUserRequest {
  questions: AskUserQuestion[]
  presentation?: AskUserActionsPresentation
  /**
   * The project of the thread asking, for a question raised outside its turn
   * (an ACP agent's own continuation asking to go on). A running turn's project
   * is used otherwise. With neither, the question stays on the desktop and is
   * not offered to interactive clients.
   */
  projectId?: string
}

export interface AskUserResult {
  /** One answer per question, in order. Empty strings mean "left blank". */
  answers: string[]
  /**
   * The run stopped before the user answered. The answers are blank, but no one
   * left them blank: the question was withdrawn, so a caller must not report it
   * as answered.
   */
  cancelled?: true
  /**
   * No answer arrived within {@link ASK_USER_TIMEOUT_MS}. The answers are blank
   * because the user is likely away, not because they chose to leave them blank,
   * so a caller must not report them as answered.
   */
  timedOut?: true
  /** No person is waiting on this run; the caller must preserve any reviewable question. */
  deferred?: true
}

/**
 * Transport that actually asks the user. The GUI registers a BrowserWindow/IPC
 * handler (see {@link initAskUser}); a headless host can register its own. With
 * no handler set, the request resolves to blank answers rather than hanging so
 * the agent loop never deadlocks.
 */
export type AskUserHandler = (req: AskUserRequest, signal?: AbortSignal) => Promise<AskUserResult>

let handler: AskUserHandler | null = null
const scopedHandler = new AsyncLocalStorage<AskUserHandler>()
const pendingQuestionThreads = new Map<string, { threadId: string; questions: AskUserQuestion[] }>()

/** Read-only attention projection for the mobile session view. */
export function pendingAskUserCountForThread(threadId: string): number {
  let count = 0
  for (const pending of pendingQuestionThreads.values()) if (pending.threadId === threadId) count++
  return count
}

export function pendingAskUserQuestionsForThread(threadId: string): AskUserQuestion[] {
  return [...pendingQuestionThreads.values()]
    .filter((pending) => pending.threadId === threadId)
    .flatMap((pending) => pending.questions)
}

export function runWithAskUserHandler<T>(next: AskUserHandler, fn: () => T): T {
  return scopedHandler.run(next, fn)
}

export function setAskUserHandler(next: AskUserHandler | null): void {
  handler = next
}

/** One blank answer per question — the "carry on without an answer" result. */
function blankAnswers(req: AskUserRequest): AskUserResult {
  return { answers: req.questions.map(() => '') }
}

/** The run stopped while (or before) asking: blank answers, marked as withdrawn. */
function cancelledAnswers(req: AskUserRequest): AskUserResult {
  return { ...blankAnswers(req), cancelled: true }
}

/**
 * Nobody answered within {@link ASK_USER_TIMEOUT_MS}. A pending ask never
 * auto-resolves, so without this bound the agent loop would hang forever if the
 * window is closed before the user answers. The marker lets the tool tell the
 * agent the user is away, so it proceeds instead of asking again.
 */
function timedOutAnswers(req: AskUserRequest): AskUserResult {
  return { ...blankAnswers(req), timedOut: true }
}

export function requestUserAnswers(
  req: AskUserRequest,
  signal?: AbortSignal,
): Promise<AskUserResult> {
  if (signal?.aborted) return Promise.resolve(cancelledAnswers(req))
  const threadId = getActiveRunThread() ?? undefined
  if (isDeferralModeActive(threadId)) {
    return Promise.resolve({ ...blankAnswers(req), deferred: true })
  }
  const activeHandler = scopedHandler.getStore() ?? handler
  if (!activeHandler) return Promise.resolve(blankAnswers(req))
  // A question on screen is a host-side wait on a human, exactly like an
  // approval modal, so it pauses the run's sliding idle deadline the same way
  // `requestApprovalInteractive` does. Without this the 15-minute idle budget
  // keeps running while the dialog waits, and a user who thinks for longer than
  // that has the turn aborted underneath a question still asking for an answer
  // — the ask-user half of #2332. The wait stays bounded regardless:
  // ASK_USER_TIMEOUT_MS caps it at 30 minutes, so pausing the clock here cannot
  // leave a turn that neither progresses nor ever ends.
  return withRunDeadlinePaused(threadId, () =>
    requestUserAnswersUnpaused(req, activeHandler, signal),
  )
}

function requestUserAnswersUnpaused(
  req: AskUserRequest,
  activeHandler: AskUserHandler,
  signal: AbortSignal | undefined,
): Promise<AskUserResult> {
  if (!signal) return activeHandler(req)
  return new Promise<AskUserResult>((resolve, reject) => {
    // Cancel only after pending promise reactions drain: an answer that settled
    // in the same turn as the stop, even through an async handler's extra hops,
    // resolves first and is kept. `resolve` ignores whichever call comes second.
    const onAbort = (): void => {
      setImmediate(() => {
        resolve(cancelledAnswers(req))
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void activeHandler(req, signal).then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** The parts of a window the question lifecycle uses, so it runs without Electron. */
export interface AskUserWindow {
  isDestroyed: () => boolean
  /** Deliver to the renderer. Only called while the window is alive. */
  send: (channel: 'agent:ask-user-request' | 'agent:ask-user-cancelled', payload: object) => void
  onClosed: (listener: () => void) => void
}

/**
 * Register the window-backed question handler and tie its pending questions to
 * `window`'s lifetime. `respond` settles one with the renderer's answers;
 * `replay` re-sends every question still open.
 *
 * Electron throws on touching a destroyed window, and this boot-time window can
 * be closed while the app (another main window, a running turn) lives on. So
 * nothing is sent to a destroyed window: an unguarded send used to throw out of
 * the close listener on the first pending question, before its promise
 * resolved, leaving that turn and every later question hanging.
 */
export function attachAskUserToWindow(
  window: AskUserWindow,
  alertUser: UserAlertSender,
): { respond: (id: string, answers: string[]) => void; replay: () => void } {
  const pending = new Map<string, (result: AskUserResult) => void>()
  const replay = new Map<
    string,
    {
      threadId: string | undefined
      questions: AskUserQuestion[]
      presentation?: AskUserActionsPresentation
    }
  >()
  const settle = (id: string, result: AskUserResult): void => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    replay.delete(id)
    pendingQuestionThreads.delete(id)
    resolve(result)
  }

  // If the window goes away, resolve everything still pending with blank answers
  // so the agent loop unblocks instead of hanging on a dead renderer.
  window.onClosed(() => {
    for (const id of [...pending.keys()]) settle(id, { answers: [] })
  })

  const windowHandler = createWindowAskUserHandler({
    send: (channel, payload) => {
      if (!window.isDestroyed()) window.send(channel, payload)
    },
    register: (id, resolve, context) => {
      pending.set(id, resolve)
      replay.set(id, context)
      if (context.threadId)
        pendingQuestionThreads.set(id, {
          threadId: context.threadId,
          questions: context.questions,
        })
    },
    settle,
    alertUser,
  })
  setAskUserHandler((req, signal) => {
    // Nobody can see a question in a destroyed window: answer as the close
    // listener would have, rather than waiting out the 30-minute timeout.
    if (window.isDestroyed()) return Promise.resolve({ answers: [] })
    return windowHandler(req, signal)
  })

  return {
    respond: (id, answers): void => {
      settle(id, { answers })
    },
    replay: (): void => {
      if (window.isDestroyed()) return
      for (const [id, context] of replay) {
        window.send('agent:ask-user-request', { id, ...context })
      }
    },
  }
}

export function initAskUser(
  win: BrowserWindow,
  ipcMain: IpcMain,
  alertUser: UserAlertSender,
): (target: object) => void {
  const questions = attachAskUserToWindow(
    {
      isDestroyed: () => win.isDestroyed(),
      send: (channel, payload) => {
        win.webContents.send(channel, payload)
      },
      onClosed: (listener) => {
        win.on('closed', listener)
      },
    },
    alertUser,
  )

  ipcMain.handle('ask:respond', (event, ...rawArgs) => {
    try {
      // Only the window's main frame may answer — an embedded/compromised frame
      // can't satisfy a pending question on the agent's behalf.
      assertMainFrameSender(event, win)
      const [id, answers] = parseIpcArgs(askRespondSchema, rawArgs)
      questions.respond(id, answers)
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  return (target): void => {
    if (win.isDestroyed() || target !== win.webContents) return
    questions.replay()
  }
}

/** What the window-backed handler needs from `initAskUser`'s window and pending map. */
export interface WindowAskUserDeps {
  send: (channel: 'agent:ask-user-request' | 'agent:ask-user-cancelled', payload: object) => void
  register: (
    id: string,
    resolve: (result: AskUserResult) => void,
    context: {
      threadId: string | undefined
      questions: AskUserQuestion[]
      presentation?: AskUserActionsPresentation
    },
  ) => void
  settle: (id: string, result: AskUserResult) => void
  alertUser: UserAlertSender
}

/**
 * The handler that shows the question in the window and waits for `ask:respond`.
 * A stop withdraws the question as cancelled; the timeout withdraws it as timed
 * out, which the tool reports as "the user is away", not as blank answers.
 */
export function createWindowAskUserHandler(deps: WindowAskUserDeps): AskUserHandler {
  return (req, signal) =>
    new Promise<AskUserResult>((resolve) => {
      if (signal?.aborted) {
        resolve(cancelledAnswers(req))
        return
      }
      const id = randomUUID()
      // Attribute to the running thread so a background thread's question
      // surfaces as a sidebar attention indicator instead of interrupting
      // whichever thread the user is currently focused on.
      const threadId = getActiveRunThread() ?? undefined
      const stopAlert = deps.alertUser('interaction', 'An agent has a question.', threadId)
      const withdraw = (result: AskUserResult): void => {
        deps.settle(id, result)
      }
      // Settle as cancelled here too: this listener runs before the deferred
      // one in `requestUserAnswersUnpaused`, so a plain blank result would win
      // and record the withdrawn question as answered.
      const onAbort = (): void => {
        withdraw(cancelledAnswers(req))
      }
      const timer = setTimeout(() => {
        withdraw(timedOutAnswers(req))
      }, ASK_USER_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      // The asker's own project, never whichever one the window has open.
      const projectId = req.projectId ?? getThreadExecutionContext()?.projectId
      const removeDecision =
        projectId && threadId
          ? humanDecisions.register(
              projectId,
              threadId,
              { id, kind: 'question', questions: req.questions },
              (answer, device) => {
                if (answer.kind !== 'question') return
                recordDecision({
                  projectId,
                  threadId,
                  kind: 'ask-user',
                  actor: humanDecisionActor(device),
                  verdict: 'approved',
                  subject: 'Answered agent questions',
                  source: humanDecisionSource(device),
                })
                deps.settle(id, { answers: answer.answers })
              },
            )
          : (): void => {}
      deps.register(
        id,
        (result) => {
          removeDecision()
          deps.send('agent:ask-user-cancelled', { id })
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          stopAlert()
          resolve(result)
        },
        {
          threadId,
          questions: req.questions,
          ...(req.presentation === undefined ? {} : { presentation: req.presentation }),
        },
      )
      signal?.addEventListener('abort', onAbort, { once: true })
      deps.send('agent:ask-user-request', {
        id,
        threadId,
        questions: req.questions,
        ...(req.presentation === undefined ? {} : { presentation: req.presentation }),
      })
    })
}
