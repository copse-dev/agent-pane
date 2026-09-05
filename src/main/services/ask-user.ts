import type { BrowserWindow, IpcMain } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { AskUserQuestion } from '@copse/agent/ask-user-format.ts'
import {
  askRespondSchema,
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
} from '../ipc/ipc-guards.ts'
import { getActiveRunThread } from './thread-models.ts'
import { withRunDeadlinePaused } from './hooks/run-deadline.ts'
import type { UserAlertSender } from './user-alerts.ts'

export interface AskUserRequest {
  questions: AskUserQuestion[]
}

export interface AskUserResult {
  /** One answer per question, in order. Empty strings mean "left blank". */
  answers: string[]
}

// A pending ask never auto-resolves, so the agent loop would hang forever if the
// window is closed before the user answers. Bound the wait and return blanks on
// timeout so the loop unblocks and the agent can proceed without an answer.
const ASK_USER_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Transport that actually asks the user. The GUI registers a BrowserWindow/IPC
 * handler (see {@link initAskUser}); a headless host can register its own. With
 * no handler set, the request resolves to blank answers rather than hanging so
 * the agent loop never deadlocks.
 */
export type AskUserHandler = (req: AskUserRequest, signal?: AbortSignal) => Promise<AskUserResult>

let handler: AskUserHandler | null = null
const scopedHandler = new AsyncLocalStorage<AskUserHandler>()

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

export function requestUserAnswers(
  req: AskUserRequest,
  signal?: AbortSignal,
): Promise<AskUserResult> {
  const activeHandler = scopedHandler.getStore() ?? handler
  if (!activeHandler || signal?.aborted) return Promise.resolve(blankAnswers(req))
  // A question on screen is a host-side wait on a human, exactly like an
  // approval modal, so it pauses the run's sliding idle deadline the same way
  // `requestApprovalInteractive` does. Without this the 15-minute idle budget
  // keeps running while the dialog waits, and a user who thinks for longer than
  // that has the turn aborted underneath a question still asking for an answer
  // — the ask-user half of #2332. The wait stays bounded regardless:
  // ASK_USER_TIMEOUT_MS caps it at 30 minutes, so pausing the clock here cannot
  // leave a turn that neither progresses nor ever ends.
  const threadId = getActiveRunThread() ?? undefined
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
    const onAbort = (): void => {
      resolve(blankAnswers(req))
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

export function initAskUser(
  win: BrowserWindow,
  ipcMain: IpcMain,
  alertUser: UserAlertSender,
): void {
  const pending = new Map<string, (result: AskUserResult) => void>()
  const settle = (id: string, result: AskUserResult): void => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(result)
  }

  ipcMain.handle('ask:respond', (event, ...rawArgs) => {
    try {
      // Only the window's main frame may answer — an embedded/compromised frame
      // can't satisfy a pending question on the agent's behalf.
      assertMainFrameSender(event, win)
      const [id, answers] = parseIpcArgs(askRespondSchema, rawArgs)
      settle(id, { answers })
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  // If the window goes away, resolve everything still pending with blank answers
  // so the agent loop unblocks instead of hanging on a dead renderer.
  win.on('closed', () => {
    for (const [id, resolve] of pending) {
      pending.delete(id)
      resolve({ answers: [] })
    }
  })

  setAskUserHandler(
    (req, signal) =>
      new Promise<AskUserResult>((resolve) => {
        const blank = (): AskUserResult => ({ answers: req.questions.map(() => '') })
        if (signal?.aborted) {
          resolve(blank())
          return
        }
        const id = randomUUID()
        // Attribute to the running thread so a background thread's question
        // surfaces as a sidebar attention indicator instead of interrupting
        // whichever thread the user is currently focused on.
        const threadId = getActiveRunThread() ?? undefined
        const stopAlert = alertUser('interaction', 'An agent has a question.')
        const cancel = (): void => {
          win.webContents.send('agent:ask_user_cancelled', { id })
          settle(id, blank())
        }
        const timer = setTimeout(() => {
          cancel()
        }, ASK_USER_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(id, (result) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          stopAlert()
          resolve(result)
        })
        signal?.addEventListener('abort', cancel, { once: true })
        win.webContents.send('agent:ask_user_request', { id, threadId, questions: req.questions })
      }),
  )
}
