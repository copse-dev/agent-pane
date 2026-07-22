import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { getCopseUserDataDir } from './helpers.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('settings usage plan worth-it', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-plan-worth-it')
    // Two completed weekly windows with high API-equivalent burn → worth_it at $100/mo.
    const configPath = join(getCopseUserDataDir(), 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    config.planWindowHistory = {
      samples: [
        {
          at: Date.now() - 14 * 24 * 60 * 60 * 1000,
          provider: 'claude',
          planLabel: 'Weekly $90 / $100',
          windows: [
            {
              id: 'seven_day',
              label: 'Weekly',
              usedPercent: 90,
              resetsAt: '2026-07-10T00:00:00Z',
              usedDollars: 90,
              limitDollars: 100,
            },
          ],
        },
        {
          at: Date.now() - 7 * 24 * 60 * 60 * 1000,
          provider: 'claude',
          planLabel: 'Weekly $5 / $100',
          windows: [
            {
              id: 'seven_day',
              label: 'Weekly',
              usedPercent: 5,
              resetsAt: '2026-07-17T00:00:00Z',
              usedDollars: 5,
              limitDollars: 100,
            },
          ],
        },
      ],
      completed: [
        {
          provider: 'claude',
          windowId: 'seven_day',
          label: 'Weekly',
          usedPercent: 95,
          usedDollars: 95,
          limitDollars: 100,
          endedResetsAt: '2026-07-03T00:00:00Z',
          completedAt: Date.now() - 14 * 24 * 60 * 60 * 1000,
        },
        {
          provider: 'claude',
          windowId: 'seven_day',
          label: 'Weekly',
          usedPercent: 90,
          usedDollars: 90,
          limitDollars: 100,
          endedResetsAt: '2026-07-10T00:00:00Z',
          completedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
        },
        {
          provider: 'claude',
          windowId: 'seven_day_fable',
          label: 'Weekly Fable',
          usedPercent: 100,
          endedResetsAt: '2026-07-10T00:00:00Z',
          completedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
        },
        {
          provider: 'claude',
          windowId: 'seven_day_fable',
          label: 'Weekly Fable',
          usedPercent: 100,
          endedResetsAt: '2026-07-03T00:00:00Z',
          completedAt: Date.now() - 14 * 24 * 60 * 60 * 1000,
        },
      ],
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf8')
    await browser.reloadSession()
    await browser.execute(() => window.api.usage.setClaudePlanMonthlyFee(100))
  })

  after(() => {
    resetUserData()
  })

  it('shows a worth-it verdict and switches the value map to inference prices', async () => {
    const payload = (await browser.execute(() => window.api.usage.getPlanWorthIt())) as {
      worthIt: { verdict: string; completedWeeklyCount: number }
      windowExhaustion: Array<{ windowId: string; hit: number; total: number }>
    }
    assert.equal(payload.worthIt.verdict, 'worth_it')
    assert.equal(payload.worthIt.completedWeeklyCount, 2)
    assert.ok(payload.windowExhaustion.some((r) => r.windowId === 'seven_day_fable' && r.hit === 2))

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const worthCard = $('.usage-worth-card[data-verdict="worth_it"]')
    await expect($('.usage-worth-section .usage-worth-heading')).toBeDisplayed()
    await expect(worthCard).toBeDisplayed()
    await expect($('.usage-worth-verdict')).toHaveText('Worth it vs inference')
    await expect($('#usage-worth-fee-input')).toHaveValue('100')

    await worthCard.scrollIntoView({ block: 'center' })
    await prepareE2eScreenshot()
    await saveElementScreenshot('.usage-worth-section', 'settings-usage-plan-worth-it.png')

    const inferenceBtn = $('.usage-worth-inference-btn')
    await inferenceBtn.scrollIntoView({ block: 'center' })
    await inferenceBtn.click()
    await browser.waitUntil(
      async () => {
        const coverage = await browser.execute(() => {
          const active = document.querySelector(
            '.frontier-plan-coverage [data-plan-coverage].active',
          ) as HTMLElement | null
          return active?.dataset['planCoverage'] ?? null
        })
        return coverage === 'inference'
      },
      { timeout: 5000, timeoutMsg: 'value map did not switch to Inference cost basis' },
    )

    const frontier = $('.frontier-fieldset')
    await frontier.scrollIntoView({ block: 'start' })
    await prepareE2eScreenshot()
    await saveElementScreenshot('.frontier-fieldset', 'settings-usage-plan-worth-it-inference.png')
  })
})
