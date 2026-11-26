import type { BrowserWindow, IpcMain } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { SshPromptLifecycle } from './ssh-prompt-lifecycle.ts'
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

export function initSshPrompt(win: BrowserWindow, ipcMain: IpcMain): void {
  const lifecycle = new SshPromptLifecycle()

  ipcMain.handle('ssh-prompt:respond', (event, ...rawArgs) => {
    try {
      assertMainFrameSender(event, win)
      const [id, value, remember] = parseIpcArgs(sshPromptRespondSchema, rawArgs)
      lifecycle.settle(id, { value, remember })
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  win.on('closed', () => {
    lifecycle.cancelAll()
  })

  setSshPromptHandler((req) =>
    lifecycle.request(
      {
        ...req,
        canRememberOnDevice:
          req.kind === 'secret' && req.canRememberOnDevice === true && canStoreSshCredentials(),
      },
      resolveRendererPromptTarget(win.webContents),
    ),
  )
}
