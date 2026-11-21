import { BrowserWindow, dialog, type WebContents } from 'electron'
import { nativeConfirmationPages } from './native-confirmation-pages.ts'

const MAX_PENDING_CONFIRMATIONS = 32
const confirmationQueues = new WeakMap<WebContents, { tail: Promise<void>; pending: number }>()

/** A renderer request is not proof of a human decision. The OS owns this final step. */
export async function confirmNativeAction(
  sender: WebContents,
  options: { title: string; detail: string; approveLabel?: string },
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false
  if (options.title.length > 512) {
    throw new Error('The requested action is too large to confirm safely')
  }
  const pages = nativeConfirmationPages(options.detail)
  // Existing WDIO renderer-dialog specs supply decisions at this boundary. This
  // branch is compiled out of release builds and never exposed over IPC.
  if (__COPSE_TEST_SCENARIOS__ && process.env['COPSE_E2E'] === '1') return true
  let queue = confirmationQueues.get(sender)
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 }
    confirmationQueues.set(sender, queue)
  }
  if (queue.pending >= MAX_PENDING_CONFIRMATIONS) return false
  const previous = queue.tail
  let release = (): void => undefined
  queue.tail = new Promise<void>((resolve) => {
    release = resolve
  })
  queue.pending += 1
  try {
    await previous
    if (signal?.aborted) return false
    const owner = BrowserWindow.fromWebContents(sender)
    if (!owner || owner.isDestroyed() || !owner.isVisible()) return false
    for (const [index, page] of pages.entries()) {
      if (signal?.aborted || owner.isDestroyed()) return false
      const finalPage = index === pages.length - 1
      const answer = await dialog.showMessageBox(owner, {
        type: 'warning',
        title: 'Copse permission',
        message:
          pages.length === 1
            ? options.title
            : `${options.title} (${String(index + 1)}/${String(pages.length)})`,
        detail: page,
        buttons: ['Deny', finalPage ? (options.approveLabel ?? 'Approve') : 'Next page'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        ...(signal ? { signal } : {}),
      })
      if (answer.response !== 1) return false
    }
    return !signal?.aborted && !owner.isDestroyed()
  } finally {
    queue.pending -= 1
    release()
    if (queue.pending === 0) confirmationQueues.delete(sender)
  }
}
