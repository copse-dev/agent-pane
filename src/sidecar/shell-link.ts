/**
 * Line protocol between the Node sidecar and the Tauri shell that spawned it.
 *
 * The shell (tauri-shell/src/main.rs) owns the real OS windows; the sidecar
 * owns everything else. When the electron-shim's `BrowserWindow` needs a
 * window created, shown, or closed, it sends a one-line JSON message on
 * stdout prefixed with `@copse-tauri `; the shell answers window lifecycle
 * events as one-line JSON on the sidecar's stdin.
 *
 * When no shell is attached (`COPSE_TAURI_SHELL` unset — e.g. the headless
 * smoke test), outbound messages are logged to stderr and no windows exist
 * anywhere, which is fine: the WS server still runs and a test client can
 * still drive the IPC surface.
 */
import { createInterface } from 'node:readline'

const PREFIX = '@copse-tauri '

export interface CreateWindowMessage {
  op: 'create-window'
  winId: number
  /** Path + query relative to the shell's frontendDist, e.g. `tauri.html?winId=1&…`. */
  url: string
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  title?: string
  show?: boolean
  backgroundColor?: string
}

export interface WindowOpMessage {
  op: 'window'
  winId: number
  action: 'show' | 'hide' | 'focus' | 'close' | 'maximize' | 'minimize'
}

export type ShellOutMessage = CreateWindowMessage | WindowOpMessage

export interface WindowEventMessage {
  op: 'window-event'
  winId: number
  event: 'close-requested' | 'closed' | 'focus' | 'blur'
}

export type ShellInMessage = WindowEventMessage

export function isShellAttached(): boolean {
  return process.env['COPSE_TAURI_SHELL'] === '1'
}

export function shellSend(message: ShellOutMessage): void {
  if (!isShellAttached()) {
    console.error(`[shell-link] detached, dropping: ${JSON.stringify(message)}`)
    return
  }
  process.stdout.write(`${PREFIX}${JSON.stringify(message)}\n`)
}

const handlers = new Set<(message: ShellInMessage) => void>()

export function onShellMessage(handler: (message: ShellInMessage) => void): void {
  handlers.add(handler)
}

let started = false

export function startShellLink(): void {
  if (!isShellAttached() || started) return
  started = true
  createInterface({ input: process.stdin }).on('line', (line) => {
    let message: ShellInMessage
    try {
      // Trusted peer: the shell is our own parent process on a private pipe.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      message = JSON.parse(line) as ShellInMessage
    } catch {
      console.error(`[shell-link] unparseable line from shell: ${line}`)
      return
    }
    for (const handler of handlers) handler(message)
  })
}
