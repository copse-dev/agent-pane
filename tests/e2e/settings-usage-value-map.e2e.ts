import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import {
  pinTextForCapture,
  prepareE2eScreenshot,
  saveElementScreenshot,
  waitForSettledLayout,
} from './helpers/screenshot.ts'

describe('settings usage model value map cost axis', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-value-map-cost', {
      model: 'acp:codex-acp#gpt-6-astra',
      // Keep the normal fixture width; only height needs more space so the
      // complete chart can be captured without moving its hovered point.
      windowBounds: { width: 1200, height: 1000 },
      registeredAcpAgents: [
        {
          id: 'codex-acp',
          title: 'Codex',
          command: 'codex-acp',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
            { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
            { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
            { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
            { value: 'gpt-5.5', label: 'GPT-5.5' },
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

    // Active state must not reflow pill width (font-weight stays constant).
    const widthBefore = {
      blended: await blendedBtn.getSize('width'),
      task: await taskBtn.getSize('width'),
    }

    const chart = fieldset.$('.frontier-chart svg')
    await expect(chart).toBeDisplayed()
    assert.equal(await chart.getAttribute('data-cost-axis'), 'blended')
    assert.match(await chart.getText(), /Blended price/)
    // Axis labels are sentence case, like the AA task-cost axis.
    assert.equal(
      await browser.execute(
        () => document.querySelector('.frontier-chart svg text[transform^="rotate"]')?.textContent,
      ),
      'Intellect',
    )
    // The chart shares the picker's available ACP model list. A statically
    // tracked model that this agent does not advertise stays behind Discover.
    assert.equal(
      await fieldset.$('circle.frontier-point[data-model-id="claude-fable-5"]').isExisting(),
      false,
    )
    assert.equal(
      await fieldset
        .$('circle.frontier-point.plan[data-model-id="acp:codex-acp#gpt-6-astra"]')
        .isExisting(),
      true,
    )
    assert.equal(
      await fieldset.$('circle.frontier-point.plan[data-model-id^="gpt-"]').isExisting(),
      false,
      'only the Codex agent route should be marked as plan included',
    )
    assert.match(await chart.getText(), /GPT-6 Astra \(~\) · plan/)
    assert.equal(await fieldset.$('details.frontier-unpriced-list').isExisting(), false)

    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-mtok.png')

    await taskBtn.click()
    await browser.waitUntil(
      async () => (await chart.getAttribute('data-cost-axis')) === 'perTask',
      { timeout: 5000, timeoutMsg: 'value map did not switch to $/task axis' },
    )
    assert.equal(
      await blendedBtn.getSize('width'),
      widthBefore.blended,
      '$/MTok pill width must not change when deselected',
    )
    assert.equal(
      await taskBtn.getSize('width'),
      widthBefore.task,
      '$/task pill width must not change when selected',
    )
    const taskChartText = await chart.getText()
    assert.match(taskChartText, /AA cost per Intelligence Index task/)
    // Subscription-backed Codex models remain plan routes on the task axis.
    assert.match(taskChartText, /GPT-6 Astra \(~\) · plan/)
    assert.equal(await taskBtn.getAttribute('aria-pressed'), 'true')
    assert.equal(await fieldset.$('details.frontier-unpriced-list').isExisting(), false)

    // Element screenshots scroll oversized subjects before capturing. Give
    // the complete chart real viewport space and position it before hovering,
    // so that scroll cannot move the pointer onto a different model.
    let restoreResetDay: (() => Promise<void>) | undefined
    try {
      await prepareE2eScreenshot({ width: 1200, height: 1000 })
      await browser.execute(() => {
        document.querySelector('.frontier-fieldset')?.scrollIntoView({
          behavior: 'instant',
          block: 'start',
        })
      })
      await waitForSettledLayout('.frontier-fieldset')
      await saveElementScreenshot('.frontier-fieldset', 'settings-usage-value-map-task.png', {
        frame: 'document',
        beforeCapture: async () => {
          const fullyVisible = await browser.execute(() => {
            const fieldset = document.querySelector('.frontier-fieldset')
            if (!fieldset) throw new Error('The chart is missing')
            const rect = fieldset.getBoundingClientRect()
            if (
              !(
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom <= window.innerHeight &&
                rect.right <= window.innerWidth
              )
            )
              return false
            for (let parent = fieldset.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent)
              const bounds = parent.getBoundingClientRect()
              if (
                style.overflowX !== 'visible' &&
                (rect.left < bounds.left + parent.clientLeft ||
                  rect.right > bounds.left + parent.clientLeft + parent.clientWidth)
              )
                return false
              if (
                style.overflowY !== 'visible' &&
                (rect.top < bounds.top + parent.clientTop ||
                  rect.bottom > bounds.top + parent.clientTop + parent.clientHeight)
              )
                return false
            }
            return true
          })
          assert.ok(fullyVisible, 'the entire chart fits before the pointer selects its tooltip')
          const planWindow = await browser.execute(async () => {
            const snapshot = await window.api.usage.getPlanUsage()
            const codex = snapshot.providers.find((provider) => provider.provider === 'codex')
            if (codex?.status !== 'ok') throw new Error('Codex mock plan is unavailable')
            const primary = codex.usage.windows.find((window) => window.id === 'primary')
            if (!primary?.resetsAt) throw new Error('Codex plan has no reset timestamp')
            return {
              usedPercent: primary.usedPercent,
              checkedAt: snapshot.checkedAt,
              resetsAt: primary.resetsAt,
              resetIsFuture: Date.parse(primary.resetsAt) > Date.now(),
              weekday: new Date(primary.resetsAt).toLocaleDateString(undefined, {
                weekday: 'short',
              }),
            }
          })
          assert.equal(planWindow.usedPercent, 11)
          assert.ok(Date.parse(planWindow.resetsAt) > Date.parse(planWindow.checkedAt))
          assert.ok(
            planWindow.resetIsFuture,
            'the plan reset is still in the future at capture time',
          )
          await fieldset
            .$('circle.frontier-point[data-model-id="acp:codex-acp#gpt-5.6-luna"]')
            .moveTo()
          const tooltip = $('.frontier-tooltip-content')
          await expect(tooltip).toBeDisplayed()
          await expect(tooltip).toHaveText(expect.stringContaining('GPT-5.6 Luna'))
          await expect(tooltip).toHaveText(
            expect.stringContaining(`11% of this plan window used, resets ${planWindow.weekday}.`),
          )
          restoreResetDay = await pinTextForCapture(
            '.frontier-tooltip-content',
            /(?<=11% of this plan window used, resets )[A-Za-z]+(?=\.)/g,
            'Mon',
          )
        },
      })
    } finally {
      await restoreResetDay?.()
      await prepareE2eScreenshot()
    }

    const discoverBtn = fieldset.$('button.frontier-discover')
    await expect(discoverBtn).toBeDisplayed()
    const discoverLabels = await discoverBtn.$$('.frontier-discover-label')
    assert.equal(discoverLabels.length, 2)
    const inactiveDiscoverLabel = discoverLabels[0]
    const activeDiscoverLabel = discoverLabels[1]
    assert.ok(inactiveDiscoverLabel)
    assert.ok(activeDiscoverLabel)
    assert.deepEqual(
      [
        await inactiveDiscoverLabel.getAttribute('aria-hidden'),
        await activeDiscoverLabel.getAttribute('aria-hidden'),
      ],
      ['false', 'true'],
      'only the inactive action label should be exposed before selection',
    )
    const discoverWidthBefore = await discoverBtn.getSize('width')
    await discoverBtn.click()
    await browser.waitUntil(
      async () => (await discoverBtn.getAttribute('aria-pressed')) === 'true',
      { timeout: 5000, timeoutMsg: 'value map did not enable model discovery' },
    )
    assert.equal(
      await discoverBtn.getSize('width'),
      discoverWidthBefore,
      'Discover models pill width must not change when selected',
    )
    assert.deepEqual(
      [
        await inactiveDiscoverLabel.getAttribute('aria-hidden'),
        await activeDiscoverLabel.getAttribute('aria-hidden'),
      ],
      ['true', 'false'],
      'only the active action label should be exposed after selection',
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

    // A translation can make either state the wider label. The hidden label
    // must still reserve intrinsic space so switching state never reflows.
    await browser.execute(() => {
      const labels = document.querySelectorAll<HTMLElement>(
        '.frontier-fieldset .frontier-discover-label',
      )
      const inactiveLabel = labels[0]
      const activeLabel = labels[1]
      if (!inactiveLabel || !activeLabel) throw new Error('Discover labels not found')
      inactiveLabel.textContent = 'Discover every available model in this workspace'
      activeLabel.textContent = 'Hide'
    })
    const translatedWidth = await discoverBtn.getSize('width')
    await discoverBtn.click()
    await browser.waitUntil(
      async () => (await discoverBtn.getAttribute('aria-pressed')) === 'false',
      {
        timeout: 5000,
        timeoutMsg: 'value map did not disable model discovery',
      },
    )
    assert.equal(
      await discoverBtn.getSize('width'),
      translatedWidth,
      'translated pill width must remain stable when the inactive label is wider',
    )
  })
})
