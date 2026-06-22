/**
 * Minimal transient error/notice surface.
 *
 * Renderer IPC failures (e.g. `fs.writeFile`, git ops) were previously fired as
 * `void api.…()` with no `.catch`, so a failed save vanished silently. Routing
 * them through `showErrorToast` gives the user a visible, non-blocking signal.
 */

const TOAST_HOST_ID = 'toast-host'
const DEFAULT_DURATION_MS = 6000

function ensureHost(): HTMLElement {
  let host = document.getElementById(TOAST_HOST_ID)
  if (!host) {
    host = document.createElement('div')
    host.id = TOAST_HOST_ID
    host.className = 'toast-host'
    host.setAttribute('role', 'status')
    host.setAttribute('aria-live', 'polite')
    document.body.append(host)
  }
  return host
}

function normalizeMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

export function showToast(
  message: string,
  opts: { variant?: 'error' | 'info'; durationMs?: number } = {},
): () => void {
  const host = ensureHost()
  const toast = document.createElement('div')
  toast.className = `toast toast-${opts.variant ?? 'info'}`
  // textContent (not innerHTML) — error messages may contain untrusted paths.
  toast.textContent = message
  host.append(toast)

  const dismiss = () => toast.remove()
  toast.addEventListener('click', dismiss)
  const timer = setTimeout(dismiss, opts.durationMs ?? DEFAULT_DURATION_MS)
  return () => {
    clearTimeout(timer)
    dismiss()
  }
}

/** Surface a caught IPC/write error to the user. Always logs to the console too. */
export function showErrorToast(prefix: string, error: unknown): void {
  const message = `${prefix}: ${normalizeMessage(error)}`
  console.error(message, error)
  const e2e = (window as Window & { __copseE2e?: { pushErrorToast?: (m: string) => void } })
    .__copseE2e
  e2e?.pushErrorToast?.(message)
  showToast(message, { variant: 'error' })
}
