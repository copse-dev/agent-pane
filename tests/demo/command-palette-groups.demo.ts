import { $, $$, browser, expect } from '@wdio/globals'
import assert from 'node:assert/strict'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Group labels across the app are sentence case (docs/ui-taste.md, "In-pane
// group headers"); the command palette is the densest place they repeat.
describe('the command palette groups', () => {
  it('labels its groups in sentence case', async () => {
    await browser.url('/?scenario=thread-context')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // metaKey covers macOS, ctrlKey the rest — the handler accepts either.
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      )
    })
    const dialog = $('#command-palette-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })

    // getText() is the rendered text, so this is what a user reads.
    const labels = await $$('.command-palette-section').map((label) => label.getText())
    assert.deepEqual(labels.slice(0, 3), ['Threads', 'Projects', 'Panels'])
    await expect($('.command-palette-section')).toHaveStyle({ 'text-transform': 'none' })

    await saveElementScreenshot('#command-palette-dialog', 'command-palette-groups.png')
  })
})
