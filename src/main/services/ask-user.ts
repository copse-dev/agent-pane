import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AskUserQuestion } from '@shared/agent/ask-user-format.ts'
import {
  askRespondSchema,
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
} from '../ipc/ipc-guards.ts'

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
export type AskUserHandler = (req: AskUserRequest) => Promise<AskUserResult>

let handler: AskUserHandler | null = null

export function setAskUserHandler(next: AskUserHandler | null): void {
  handler = next
}

export function requestUserAnswers(req: AskUserRequest): Promise<AskUserResult> {
  if (!handler) return Promise.resolve({ answers: req.questions.map(() => '') })
  return handler(req)
}

export function initAskUser(win: BrowserWindow): void {
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
    (req) =>
      new Promise<AskUserResult>((resolve) => {
        const id = randomUUID()
        win.webContents.send('agent:ask_user_request', { id, questions: req.questions })
        const timer = setTimeout(() => {
          settle(id, { answers: req.questions.map(() => '') })
        }, ASK_USER_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(id, (result) => {
          clearTimeout(timer)
          resolve(result)
        })
      }),
  )
}
