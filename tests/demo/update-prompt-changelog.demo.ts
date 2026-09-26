import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted update prompt changelog', () => {
  before(async () => {
    await browser.url('/?scenario=update-prompt-changelog')
    await $('#update-prompt-dialog').waitForDisplayed()
  })

  it('lists every missed release newest first, inside the viewport', async () => {
    const dialog = $('#update-prompt-dialog')
    await expect(dialog.$('.update-prompt-message')).toHaveText('Copse 0.1.0-beta.11 is available')
    await expect(dialog.$('.update-prompt-changelog-title')).toHaveText("What's new in 3 releases")
    const versions = await dialog.$$('.update-prompt-version').map((heading) => heading.getText())
    assert.deepEqual(versions, ['0.1.0-beta.11', '0.1.0-beta.10', '0.1.0-beta.9'])
    await expect(dialog.$$('.update-prompt-release')[0].$$('li')).toBeElementsArrayOfSize(3)
    await expect(dialog.$$('.update-prompt-release')[2]).toHaveText(
      expect.stringContaining('No notes for this release.'),
    )
    await expect(dialog.$('.update-prompt-all-notes')).toHaveAttribute(
      'href',
      'https://github.com/copse-dev/copse-releases/releases',
    )

    const layout = await browser.execute(() => {
      const dialog = document.querySelector('#update-prompt-dialog')
      const list = document.querySelector('.update-prompt-changelog-list')
      const buttons = document.querySelector('.update-prompt-buttons')
      if (!dialog || !list || !buttons) return null
      const dialogRect = dialog.getBoundingClientRect()
      return {
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
        viewportHeight: window.innerHeight,
        listBottom: list.getBoundingClientRect().bottom,
        buttonsTop: buttons.getBoundingClientRect().top,
      }
    })
    assert.ok(layout, 'update prompt geometry must exist')
    assert.ok(layout.dialogTop >= 0 && layout.dialogBottom <= layout.viewportHeight)
    assert.ok(layout.listBottom <= layout.buttonsTop, 'the changelog must not push the buttons off')

    await saveElementScreenshot('#update-prompt-dialog', 'update-prompt-changelog.png')
  })

  it('renders release-note markup inert', async () => {
    // Notes are fetched from GitHub; the sanitizing renderer must drop active markup.
    const notes = $$('.update-prompt-notes')[1]
    await expect(notes).toHaveText(expect.stringContaining('Hardened update checks.'))
    await expect(notes.$$('script')).toBeElementsArrayOfSize(0)
    const imgHandlers = await browser.execute(
      () =>
        Array.from(document.querySelectorAll('.update-prompt-notes img')).filter((img) =>
          img.hasAttribute('onerror'),
        ).length,
    )
    assert.equal(imgHandlers, 0)
    assert.equal(await browser.execute(() => document.body.dataset['pwned'] ?? null), null)
  })
})
