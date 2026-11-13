import { $, browser } from '@wdio/globals'

/**
 * The chat composer is a contenteditable (`composer-editor.ts`), not a
 * `<textarea>`: WDIO's `setValue`/`getValue` operate on the `value` property
 * and are no-ops on it. Specs seed and read composer text through these
 * helpers, which go through the DOM the way the editor itself reads it.
 */
export async function setComposerValue(text: string): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await browser.execute((t) => {
    const composer = document.querySelector('.prompt-input')
    if (!(composer instanceof HTMLElement)) throw new Error('.prompt-input not found')
    composer.focus()
    composer.textContent = t
    // Place the caret at the end before `input` so slash autocomplete
    // (`skill-picker` / mentions) sees the full query. A caret left at offset 0
    // or just after `/` yields an empty filter and lists every skill — Enter
    // then inserts the alphabetically-first match (e.g. `/agent-run-eval`)
    // instead of `/checkup`.
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(composer)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
}

/** Visible composer text (paste chips read as their label + ✕). */
export async function composerText(): Promise<string> {
  return browser.execute(() => {
    const composer = document.querySelector('.prompt-input')
    return composer instanceof HTMLElement ? composer.textContent : ''
  })
}

/** Submit a fixture prompt, accepting the real dirty-checkout warning if needed. */
export async function submitComposer(): Promise<void> {
  const handlesBefore = await browser.getWindowHandles()
  const mainHandle = handlesBefore[0]
  if (!mainHandle) throw new Error('Main window handle is missing')
  const browserDemo = await browser.execute(
    () => document.documentElement.dataset['demoScenario'] !== undefined,
  )
  const dispatchesImmediately = await browser.execute(async () => {
    const activeThreadId =
      document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId']
    if (!activeThreadId) return true
    return !(await window.api.agent.runningThreadIds()).includes(activeThreadId)
  })
  await $('.submit-btn').click()
  let confirmedDirtyCheckout = false
  await browser.waitUntil(
    async () => {
      const sendAnyway = $('.composer-dirty-send-btn')
      if (!confirmedDirtyCheckout && (await sendAnyway.isDisplayed())) {
        confirmedDirtyCheckout = true
        await sendAnyway.click()
      }
      return (await composerText()).trim() === ''
    },
    { timeout: 30_000, interval: 100, timeoutMsg: 'The composer prompt did not submit' },
  )
  // Human prompts that dispatch now cross the real isolated entry surface.
  // Queued prompts open it later when their active turn finishes, so leave
  // those queued for the owning spec to observe.
  // The browser demo's supported API is an in-renderer mock: it has no main
  // process or native windows, and its composer call has already dispatched
  // the selected trace by this point. Electron E2E must cross the real
  // protected surface before the owning spec observes a turn.
  if (dispatchesImmediately && !browserDemo) {
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > handlesBefore.length,
      {
        timeout: 15_000,
        timeoutMsg: 'Protected prompt window did not open after composer submit',
      },
    )
    const protectedHandle = (await browser.getWindowHandles()).find(
      (handle) => !handlesBefore.includes(handle),
    )
    if (!protectedHandle) throw new Error('Protected prompt window handle is missing')
    await browser.switchToWindow(protectedHandle)
    await $('#protected-prompt-send').click()
    await browser.waitUntil(
      async () => !(await browser.getWindowHandles()).includes(protectedHandle),
      {
        timeout: 15_000,
        timeoutMsg: 'Protected prompt window did not close after sending',
      },
    )
    await browser.switchToWindow(mainHandle)
  }
}
