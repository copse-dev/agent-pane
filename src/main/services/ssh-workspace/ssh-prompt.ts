import type { BrowserWindow, IpcMain, WebContents } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import {
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  sshPromptRespondSchema,
} from '../../ipc/ipc-guards.ts'
import { canStoreSshCredentials } from './ssh-credential-store.ts'
import { resolveRendererPromptTarget } from '../renderer-prompt-target.ts'

export type SshPromptKind = 'confirm' | 'secret'

export interface SshPromptRequest {
  prompt: string
  kind: SshPromptKind
  /** Whether a checked remember control can persist through the OS keyring. */
  canRememberOnDevice?: boolean
}

export interface SshPromptResponse {
  /** Empty when the user cancelled or the prompt timed out. */
  value: string
  /**
   * Whether to remember this secret. Configured-host prompts persist through
   * the OS-keyring-backed store; other prompts remain session-only. Absent for
   * confirm prompts, cancellations, and timeouts.
   */
  remember?: boolean
}

const SSH_PROMPT_TIMEOUT_MS = 60_000

export type SshPromptHandler = (req: SshPromptRequest) => Promise<SshPromptResponse>

let handler: SshPromptHandler | null = null
const scopedHandler = new AsyncLocalStorage<SshPromptHandler>()

export function runWithSshPromptHandler<T>(next: SshPromptHandler, fn: () => T): T {
  return scopedHandler.run(next, fn)
}

export function setSshPromptHandler(next: SshPromptHandler | null): void {
  handler = next
}

export function requestSshPrompt(req: SshPromptRequest): Promise<SshPromptResponse> {
  const activeHandler = scopedHandler.getStore() ?? handler
  return activeHandler ? activeHandler(req) : Promise.resolve({ value: '' })
}

/** Host-key style prompts expect a literal `yes`; everything else is a secret. */
export function classifySshPrompt(prompt: string): SshPromptKind {
  return /continue connecting|authenticity of host|fingerprint|yes\/no/i.test(prompt)
    ? 'confirm'
    : 'secret'
}

export function initSshPrompt(
  win: BrowserWindow,
  ipcMain: IpcMain,
  confirmSshPrompt: (
    sender: WebContents,
    request: SshPromptRequest,
    response: SshPromptResponse,
  ) => Promise<boolean>,
): void {
  const pending = new Map<
    string,
    { request: SshPromptRequest; resolve: (result: SshPromptResponse) => void }
  >()
  const settle = (id: string, result: SshPromptResponse): void => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    entry.resolve(result)
  }

  ipcMain.handle('ssh-prompt:respond', async (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const [id, value, remember] = parseIpcArgs(sshPromptRespondSchema, rawArgs)
      const entry = pending.get(id)
      if (!entry) return
      if (entry.request.kind === 'confirm' && value !== '' && value !== 'yes') {
        throw new IpcValidationError('Invalid SSH confirmation response')
      }
      if (remember && entry.request.kind !== 'secret') {
        throw new IpcValidationError('This SSH secret cannot be remembered')
      }
      if (value && (entry.request.kind === 'confirm' || remember)) {
        const confirmed = await confirmSshPrompt(event.sender, entry.request, { value, remember })
        if (!confirmed) {
          settle(id, { value: '' })
          return
        }
      }
      if (pending.get(id) !== entry) return
      settle(id, { value, remember })
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
        // The window that asked for the connection, falling back to the main
        // one. A pop-out pane opening an SSH terminal used to get its passphrase
        // and host-key questions on the main window, where nothing said which
        // connection they belonged to — and, unanswered, they timed out under a
        // pop-out still showing a blank shell (#2507). A host key is exactly the
        // question you cannot answer without seeing what asked it.
        const dest = resolveRendererPromptTarget(win.webContents)
        if (dest.isDestroyed()) {
          resolve({ value: '' })
          return
        }
        dest.send('ssh:prompt-request', {
          id,
          prompt: req.prompt,
          kind: req.kind,
          canRememberOnDevice:
            req.kind === 'secret' && req.canRememberOnDevice === true && canStoreSshCredentials(),
        })
        const timer = setTimeout(() => {
          settle(id, { value: '' })
        }, SSH_PROMPT_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(id, {
          request: req,
          resolve: (result) => {
            clearTimeout(timer)
            resolve(result)
          },
        })
      }),
  )
}
