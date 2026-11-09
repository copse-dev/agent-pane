import { BrowserWindow, dialog, type WebContents } from 'electron'

const MAX_PENDING_CONFIRMATIONS = 32
const confirmationQueues = new WeakMap<WebContents, { tail: Promise<void>; pending: number }>()

/** A renderer request is not proof of a human decision. The OS owns this final step. */
export async function confirmNativeAction(
  sender: WebContents,
  options: { title: string; detail: string; approveLabel?: string },
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false
  if (options.title.length > 512 || options.detail.length > 16_000) {
    throw new Error('The requested action is too large to confirm safely')
  }
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
    const answer = await dialog.showMessageBox(owner, {
      type: 'warning',
      title: 'Copse permission',
      message: options.title,
      detail: options.detail,
      buttons: ['Deny', options.approveLabel ?? 'Approve'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      ...(signal ? { signal } : {}),
    })
    return answer.response === 1 && !signal?.aborted && !owner.isDestroyed()
  } finally {
    queue.pending -= 1
    release()
    if (queue.pending === 0) confirmationQueues.delete(sender)
  }
}
