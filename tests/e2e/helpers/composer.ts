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
    return composer instanceof HTMLElement ? (composer.textContent ?? '') : ''
  })
}
