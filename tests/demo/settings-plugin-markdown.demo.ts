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

  it('lays plugins out as unframed rows with the publisher in the name line', async () => {
    const layout = await browser.execute(() => {
      const list = document.querySelector('#plugins-list')
      const row = list?.querySelector<HTMLElement>(
        '.plugin-row[data-plugin-id="copse.advisor-strategy"]',
      )
      const line = row?.querySelector<HTMLElement>('.plugin-row-name-line')
      const publisher = line?.querySelector<HTMLElement>('.plugin-badge-first-party')
      const fold = row?.querySelector<HTMLElement>('.plugin-settings-fold')
      const chip = row?.querySelector<HTMLElement>('.plugin-chip')
      if (!list || !row || !line || !publisher || !fold || !chip) return null
      const rowStyle = getComputedStyle(row)
      const chipStyle = getComputedStyle(chip)
      return {
        background: rowStyle.backgroundColor,
        border: rowStyle.borderTopWidth,
        nameLine: line.textContent.replaceAll(/\s+/g, ''),
        publisherTransform: getComputedStyle(publisher).textTransform,
        captionsOverName: list.querySelectorAll('.plugin-row-title > .plugin-badge').length,
        stableBadges: list.querySelectorAll('.plugin-badge-stable').length,
        foldRule: getComputedStyle(fold).borderTopWidth,
        chip: { border: chipStyle.borderTopWidth, background: chipStyle.backgroundColor },
      }
    })
    assert.ok(layout, 'the advisor row renders its name line, fold and a capability count')
    // No card: the gap between rows separates them (docs/ui-taste.md).
    assert.equal(layout.background, 'rgba(0, 0, 0, 0)')
    assert.equal(layout.border, '0px')
    assert.equal(layout.foldRule, '0px')
    // "Advisor strategy 0.3.1 · Copse Experimental": the publisher follows the
    // version in sentence case, and only the exception is badged (its text is the
    // lowercase data value; the badge recipe capitalises it).
    assert.equal(layout.nameLine, 'Advisorstrategy0.3.1·Copseexperimental')
    assert.equal(layout.publisherTransform, 'none')
    assert.equal(layout.captionsOverName, 0)
    // Stable is the default and is not badged; capability counts are text.
    assert.equal(layout.stableBadges, 0)
    assert.deepEqual(layout.chip, { border: '0px', background: 'rgba(0, 0, 0, 0)' })

    await $('#plugins-list').scrollIntoView({ block: 'start' })
    await saveElementScreenshot('#settings-dialog', 'settings-plugin-rows.png')
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
    assert.match(await hint.getText(), /advisor[”"] role still takes precedence/i)

    await advisor.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '#plugins-list .plugin-row[data-plugin-id="copse.advisor-strategy"]',
      'settings-advisor-model.png',
    )
  })
})
