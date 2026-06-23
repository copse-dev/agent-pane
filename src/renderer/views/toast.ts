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
  // Worker / resource failures reject with an ErrorEvent or a plain Event whose
  // default stringification ("[object ErrorEvent]") is useless — describe them.
  if (typeof ErrorEvent !== 'undefined' && error instanceof ErrorEvent) {
    return describeErrorEvent(error)
  }
  if (typeof Event !== 'undefined' && error instanceof Event) {
    return describeEvent(error)
  }
  return String(error)
}

/** ErrorEvent → nested Error message, else its message plus source location. */
function describeErrorEvent(event: ErrorEvent): string {
  if (event.error instanceof Error && event.error.message) return event.error.message
  const location = formatSourceLocation(event.filename, event.lineno, event.colno)
  if (event.message) return location ? `${event.message} (${location})` : event.message
  if (location) return `script error at ${location}`
  return describeEvent(event)
}

/** Generic Event → the failed element (tag + src/href) when there is a target. */
function describeEvent(event: Event): string {
  const target = event.target
  if (typeof Element !== 'undefined' && target instanceof Element) {
    const tag = target.tagName.toLowerCase()
    const src = target.getAttribute('src') ?? target.getAttribute('href')
    return src ? `failed to load <${tag}> ${src}` : `<${tag}> ${event.type} event`
  }
  return `${event.type} event`
}

function formatSourceLocation(filename?: string, lineno?: number, colno?: number): string {
  if (!filename) return ''
  const parts = [filename]
  if (lineno) parts.push(String(lineno))
  if (colno) parts.push(String(colno))
  return parts.join(':')
}

export function showToast(
  message: string,
  opts: { variant?: 'error' | 'info'; durationMs?: number } = {},
): () => void {
  const host = ensureHost()
  const variant = opts.variant ?? 'info'
  const duration = opts.durationMs ?? DEFAULT_DURATION_MS

  // Collapse identical bursts (e.g. several Monaco workers failing at once)
  // into a single toast so the user sees one clear message, not a stack of
  // duplicates. Refresh the existing toast's auto-dismiss timer instead.
  const existing = findVisibleToast(message, variant)
  if (existing) {
    existing.refresh(duration)
    return existing.dismiss
  }

  const toast = document.createElement('div')
  toast.className = `toast toast-${variant}`
  // textContent (not innerHTML) — error messages may contain untrusted paths.
  toast.textContent = message
  host.append(toast)

  let timer = setTimeout(() => toast.remove(), duration)
  const dismiss = () => {
    clearTimeout(timer)
    toast.remove()
  }
  const refresh = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => toast.remove(), ms)
  }
  toastControls.set(toast, { dismiss, refresh })
  toast.addEventListener('click', dismiss)
  return dismiss
}

interface ToastControl {
  dismiss: () => void
  refresh: (ms: number) => void
}

const toastControls = new WeakMap<HTMLElement, ToastControl>()

function findVisibleToast(message: string, variant: 'error' | 'info'): ToastControl | null {
  const host = document.getElementById(TOAST_HOST_ID)
  if (!host) return null
  for (const node of host.querySelectorAll<HTMLElement>(`.toast-${variant}`)) {
    if (node.textContent === message) return toastControls.get(node) ?? null
  }
  return null
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
