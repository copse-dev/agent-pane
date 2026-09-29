import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Plugin manifests write their copy in markdown — backticked tool names — so
// the Customise rows render it rather than showing the backticks (#2450). The
// same focused surface also keeps the demo's advisor manifest in sync with the
// real first-party plugin.
describe('browser-hosted plugin rows', () => {
  before(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist()
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').$('button[data-section="customise"]').click()
    await browser.waitUntil(async () => (await $('#plugins-reload-status').getText()) === '', {
      timeout: 15_000,
      timeoutMsg: 'plugin rows did not finish refreshing',
    })
    await $('#plugins-list .plugin-row').waitForDisplayed()
  })

  it('renders inline code in a pack description', async () => {
    const todos = $('#plugins-list .plugin-row[data-plugin-id="copse.todos"]')
    await expect(todos.$('.plugin-row-desc code')).toHaveText('todo_write')
    assert.doesNotMatch(await todos.$('.plugin-row-desc').getText(), /`/)

    await todos.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '#plugins-list .plugin-row[data-plugin-id="copse.todos"]',
      'settings-plugin-markdown-description.png',
    )
  })

  it('shows the advisor model setting declared by the demo plugin', async () => {
    const advisor = $('#plugins-list .plugin-row[data-plugin-id="copse.advisor-strategy"]')
    await expect(advisor.$('.plugin-name')).toHaveText('Advisor strategy')
    await expect(advisor.$('.plugin-row-desc')).toHaveText(
      expect.stringContaining('Consult a larger advisor model mid-task'),
    )

    const summary = advisor.$('summary.plugin-settings-summary')
    // The dialog's sticky footer covers the lower rows until they scroll up.
    await summary.scrollIntoView({ block: 'center' })
    await summary.click()
    const model = advisor.$('#advisorModel')
    const modelTrigger = advisor.$('.model-picker-trigger[aria-label="Advisor model"]')
    await modelTrigger.waitForDisplayed()
    await expect(advisor.$('.plugin-setting-title')).toHaveText('Advisor model')
    await expect(modelTrigger.$('.model-picker-label')).toHaveText(
      expect.stringContaining('Most capable'),
    )
    assert.equal(await model.getValue(), 'auto:best-intellect')
    const hint = advisor.$('.plugin-setting-desc')
    await hint.waitForDisplayed()
    assert.match(await hint.getText(), /advisor role still takes precedence/i)

    await advisor.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '#plugins-list .plugin-row[data-plugin-id="copse.advisor-strategy"]',
      'settings-advisor-model.png',
    )
  })
})
