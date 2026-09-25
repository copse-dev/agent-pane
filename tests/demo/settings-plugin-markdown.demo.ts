import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Plugin manifests write their copy in markdown — backticked tool and setting
// names — so the Customise rows render it rather than showing the backticks
// (#2450). Covers a pack description and a manifest setting's hint.
describe('browser-hosted plugin copy markdown', () => {
  before(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="customise"]').click()
    await $('#plugins-list .plugin-row').waitForDisplayed()
  })

  it('renders inline code in a pack description and a setting hint', async () => {
    const todos = $('#plugins-list .plugin-row[data-plugin-id="copse.todos"]')
    await expect(todos.$('.plugin-row-desc code')).toHaveText('todo_write')
    assert.doesNotMatch(await todos.$('.plugin-row-desc').getText(), /`/)

    const advisor = $('#plugins-list .plugin-row[data-plugin-id="copse.advisor-strategy"]')
    const summary = advisor.$('summary.plugin-settings-summary')
    // The dialog's sticky footer covers the lower rows until they scroll up.
    await summary.scrollIntoView({ block: 'center' })
    await summary.click()
    const hint = advisor.$('.plugin-setting-desc')
    await hint.waitForDisplayed()
    await expect(hint.$('code')).toHaveText('0')
    assert.doesNotMatch(await hint.getText(), /`/)

    // One row per shot: the dialog's sticky footer would cover a list-wide one.
    await advisor.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '#plugins-list .plugin-row[data-plugin-id="copse.advisor-strategy"]',
      'settings-plugin-markdown-setting-hint.png',
    )
    await todos.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '#plugins-list .plugin-row[data-plugin-id="copse.todos"]',
      'settings-plugin-markdown-description.png',
    )
  })
})
