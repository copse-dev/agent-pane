import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedDeveloperModeFixture } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('Developer mode surfaces', function () {
  this.timeout(90_000)

  after(() => {
    resetUserData()
  })

  it('hides diagnostics and Hooks by default, keeping the trace exits', async () => {
    resetUserData()
    seedDeveloperModeFixture(process.cwd(), false)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const overflow = $('.footer-overflow')
    await expect(overflow).toBeDisplayed()
    await overflow.$('.footer-overflow-trigger').click()
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.footer-overflow-item'), (item) =>
        item.textContent?.trim(),
      ),
    )
    // Debug trace and Share trace are the two "this went wrong" exits, so they
    // are deliberately not behind Developer mode — unlike the exports above them.
    assert.deepEqual(labels, ['Enable Guarded YOLO', 'Debug trace', 'Share trace'])
    await saveElementScreenshot('#input-bar', 'developer-mode-footer-menu-default.png')
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()
    await expect(dialog.$('[data-developer-only="hooks"]')).not.toBeDisplayed()
  })

  it('reveals the footer diagnostics menu and Hooks settings when enabled', async () => {
    resetUserData()
    seedDeveloperModeFixture(process.cwd(), true)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const overflow = $('.footer-overflow')
    await expect(overflow).toBeDisplayed()
    await overflow.$('.footer-overflow-trigger').click()
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.footer-overflow-item'), (item) =>
        item.textContent?.trim(),
      ),
    )
    assert.deepEqual(labels, [
      'Enable Guarded YOLO',
      'Copy thread ID',
      'Export conversation (JSONL)',
      'Export thread folder (ZIP)',
      'Debug trace',
      'Share trace',
    ])
    await saveElementScreenshot('#input-bar', 'developer-mode-footer-menu.png')

    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="customise"]').click()
    const hooks = dialog.$('[data-developer-only="hooks"]')
    await expect(hooks).toBeDisplayed()
    // This eval covers developer-mode visibility, not the host machine's user
    // hook inventory. Keep the screenshot deterministic and free of local paths.
    await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('#sources-hooks-list')
      if (list) list.style.display = 'none'
      const hooks = document.querySelector<HTMLElement>('[data-developer-only="hooks"]')
      const section = hooks?.closest('.settings-section')
      section?.querySelectorAll<HTMLElement>(':scope > fieldset').forEach((fieldset) => {
        if (fieldset !== hooks) fieldset.style.display = 'none'
      })
      const content = hooks?.closest<HTMLElement>('.settings-content')
      if (content) content.scrollTop = 0
    })
    await saveElementScreenshot('.settings-content', 'developer-mode-hooks-settings.png')
  })
})
