import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('settings usage model value map cost axis', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-value-map-cost', {
      model: 'acp:value-map-agent#gpt-5.6-sol',
      registeredAcpAgents: [
        {
          id: 'value-map-agent',
          title: 'Value Map Agent',
          command: 'value-map-agent',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
            { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
            { value: 'gpt-5-mini', label: 'GPT-5 mini' },
            { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
            { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('toggles the value map between $/MTok and AA $/task and screenshots both', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const fieldset = $('.frontier-fieldset')
    await expect(fieldset).toBeDisplayed()
    await expect(fieldset.$('legend')).toHaveText('Model value map')

    const blendedBtn = fieldset.$('button.frontier-cost-axis-btn[data-cost-axis="blended"]')
    const taskBtn = fieldset.$('button.frontier-cost-axis-btn[data-cost-axis="perTask"]')
    await expect(blendedBtn).toBeDisplayed()
    await expect(taskBtn).toBeDisplayed()
    assert.equal(await taskBtn.getAttribute('disabled'), null)

    const chart = fieldset.$('.frontier-chart svg')
    await expect(chart).toBeDisplayed()
    assert.equal(await chart.getAttribute('data-cost-axis'), 'blended')
    assert.match(await chart.getText(), /blended price/)
    // The chart shares the picker's available ACP model list. A statically
    // tracked model that this agent does not advertise stays behind Discover.
    assert.equal(
      await fieldset.$('circle.frontier-point[data-model-id="gpt-5.5"]').isExisting(),
      false,
    )
    assert.equal(
      await fieldset.$('circle.frontier-point[data-model-id="gpt-5.6-sol"]').isExisting(),
      true,
    )
    assert.match(await chart.getText(), /GPT-5\.6 Sol/)
    assert.equal(await fieldset.$('details.frontier-unpriced-list').isExisting(), false)

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-mtok.png')

    await taskBtn.click()
    await browser.waitUntil(
      async () => (await chart.getAttribute('data-cost-axis')) === 'perTask',
      { timeout: 5000, timeoutMsg: 'value map did not switch to $/task axis' },
    )
    const taskChartText = await chart.getText()
    assert.match(taskChartText, /AA cost per Intelligence Index task/)
    // Non-plan models (GPT) must spread across the task-cost axis — not collapse
    // to the $0 plan column alone.
    assert.match(taskChartText, /GPT-5\.6 Sol|GPT-5 mini/)
    assert.equal(await taskBtn.getAttribute('aria-pressed'), 'true')
    assert.equal(await fieldset.$('details.frontier-unpriced-list').isExisting(), false)

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-task.png')

    const discoverBtn = fieldset.$('button.frontier-discover')
    await expect(discoverBtn).toBeDisplayed()
    await discoverBtn.click()
    await browser.waitUntil(
      async () => (await discoverBtn.getAttribute('aria-pressed')) === 'true',
      { timeout: 5000, timeoutMsg: 'value map did not enable model discovery' },
    )
    // The AA fixture includes a curated, unroutable $240/MTok legacy model.
    // It belongs in the dominated disclosure and must not stretch the plot.
    assert.equal(
      await fieldset.$('circle.frontier-point[data-model-id="o1-pro"]').isExisting(),
      false,
    )
    await expect(fieldset.$('details.frontier-dominated-live')).toBeDisplayed()
    const dominatedText = await browser.execute(
      () => document.querySelector('details.frontier-dominated-live')?.textContent ?? '',
    )
    assert.match(dominatedText, /o1-pro/)
    const plottedCount = await fieldset.$$('circle.frontier-point').length
    assert.ok(
      plottedCount < 20,
      `expected a focused discovery map, plotted ${String(plottedCount)}`,
    )

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-discovery.png')
  })
})
