import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  sshPromptRespondSchema,
} from '../../ipc/ipc-guards.ts'

export type SshPromptKind = 'confirm' | 'secret'

export interface SshPromptRequest {
  prompt: string
  kind: SshPromptKind
}

export interface SshPromptResponse {
  /** Empty when the user cancelled or the prompt timed out. */
  value: string
}

const SSH_PROMPT_TIMEOUT_MS = 60_000

export type SshPromptHandler = (req: SshPromptRequest) => Promise<SshPromptResponse>

let handler: SshPromptHandler | null = null

export function setSshPromptHandler(next: SshPromptHandler | null): void {
  handler = next
}

export function requestSshPrompt(req: SshPromptRequest): Promise<SshPromptResponse> {
  return handler ? handler(req) : Promise.resolve({ value: '' })
}

/** Host-key style prompts expect a literal `yes`; everything else is a secret. */
export function classifySshPrompt(prompt: string): SshPromptKind {
  return /continue connecting|authenticity of host|fingerprint|yes\/no/i.test(prompt)
    ? 'confirm'
    : 'secret'
}

export function initSshPrompt(win: BrowserWindow): void {
  const pending = new Map<string, (result: SshPromptResponse) => void>()
  const settle = (id: string, result: SshPromptResponse): void => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(result)
  }

  ipcMain.handle('ssh-prompt:respond', (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const [id, value] = parseIpcArgs(sshPromptRespondSchema, rawArgs)
      settle(id, { value })
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  win.on('closed', () => {
    for (const [id] of pending) settle(id, { value: '' })
  })

  setSshPromptHandler(
    (req) =>
      new Promise<SshPromptResponse>((resolve) => {
        const id = randomUUID()
        win.webContents.send('ssh:prompt_request', {
          id,
          prompt: req.prompt,
          kind: req.kind,
        })
        const timer = setTimeout(() => {
          settle(id, { value: '' })
        }, SSH_PROMPT_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(id, (result) => {
          clearTimeout(timer)
          resolve(result)
        })
      }),
  )
}
