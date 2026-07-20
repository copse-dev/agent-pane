import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { getCopseUserDataDir } from './helpers.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

describe('settings usage panel', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-usage-panel')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows plan limits and ledger usage without blocking on plan fetch', async () => {
    await browser.execute(async () => {
      await window.api.usage.record({
        model: 'claude-sonnet-4-6',
        source: 'agent',
        inputTokens: 500,
        outputTokens: 50,
        threadId: 'thread-1',
        projectId: 'e2e-usage-panel',
      })
      await window.api.usage.record({
        model: 'lmstudio:qwen/qwen3.6-35b-a3b',
        source: 'agent',
        inputTokens: 1200,
        outputTokens: 300,
        threadId: 'thread-1',
        projectId: 'e2e-usage-panel',
      })
    })

    const summary = (await browser.execute(() => window.api.usage.getSummary())) as {
      ledgerEventCount: number
      day: {
        totalInputTokens: number
        cloudModels: Array<{ model: string }>
        localModels: Array<{ model: string }>
      }
    }
    assert.equal(summary.ledgerEventCount, 2)
    assert.ok(summary.day.totalInputTokens >= 1700)
    assert.ok(summary.day.cloudModels.some((m) => m.model === 'claude-sonnet-4-6'))
    assert.ok(summary.day.localModels.some((m) => m.model.startsWith('lmstudio:')))

    const plan = (await browser.execute(() => window.api.usage.getPlanUsage())) as {
      providers: Array<{ status: string; provider: string }>
    }
    assert.equal(plan.providers.length, 4)
    assert.ok(plan.providers.every((p) => p.status === 'ok'))

    const config = JSON.parse(readFileSync(join(getCopseUserDataDir(), 'config.json'), 'utf8')) as {
      usageEvents?: unknown[]
    }
    assert.equal(config.usageEvents?.length, 2)

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    await expect($('.usage-plan-section .usage-plan-heading')).toBeDisplayed()
    await expect(
      $('.usage-plan-provider[data-provider="claude"][data-status="ok"]'),
    ).toBeDisplayed()
    await expect($('.usage-plan-provider[data-provider="codex"][data-status="ok"]')).toBeDisplayed()
    await expect(
      $('.usage-plan-provider[data-provider="huggingface"][data-status="ok"]'),
    ).toBeDisplayed()
    await expect(
      $('.usage-plan-provider[data-provider="cursor"][data-status="ok"]'),
    ).toBeDisplayed()
    await expect($('.usage-plan-bar')).toBeDisplayed()
    await expect(
      $(
        '.usage-plan-provider[data-provider="claude"] .usage-plan-window[data-severity="critical"]',
      ),
    ).toBeDisplayed()
    await expect(
      $(
        '.usage-plan-provider[data-provider="claude"] .usage-plan-bar-fill[data-severity="warning"]',
      ),
    ).toBeDisplayed()
    await expect($('.usage-period-body .usage-headline')).toBeDisplayed()
    await expect($('.usage-model-group:nth-of-type(1) tbody tr')).toBeDisplayed()
    await expect($('.usage-model-group:nth-of-type(2) tbody tr')).toBeDisplayed()

    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-plan-limits.png')
  })

  it('keeps the right-edge value-map hover card wide and inside the panel', async () => {
    const fieldset = $('.frontier-fieldset')
    await expect(fieldset).toBeDisplayed()
    await fieldset.scrollIntoView({ block: 'start', inline: 'nearest' })
    await prepareE2eScreenshot()

    const hits = await $$('.frontier-chart circle.frontier-hit')
    assert.ok(hits.length > 0, 'expected value-map points to render')
    let rightmost = hits[0]
    let rightmostCx = Number(await rightmost.getAttribute('cx'))
    for (const hit of hits.slice(1)) {
      const cx = Number(await hit.getAttribute('cx'))
      if (cx > rightmostCx) {
        rightmost = hit
        rightmostCx = cx
      }
    }

    await rightmost.moveTo()
    const tooltip = $('.frontier-tooltip:not([hidden])')
    await expect(tooltip).toBeDisplayed()

    const geometry = await browser.execute(() => {
      const tip = document.querySelector('.frontier-tooltip:not([hidden])')
      const field = document.querySelector('.frontier-fieldset')
      const points = [...document.querySelectorAll('.frontier-chart circle.frontier-hit')]
      const point = points.reduce<Element | null>((rightmostPoint, candidate) => {
        if (!rightmostPoint) return candidate
        return candidate.getBoundingClientRect().x > rightmostPoint.getBoundingClientRect().x
          ? candidate
          : rightmostPoint
      }, null)
      if (!tip || !field || !point) return null
      const rect = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }
      return { tip: rect(tip), point: rect(point), field: rect(field) }
    })
    assert.ok(geometry, 'expected hover-card geometry')
    const { tip: tipRect, point: pointRect, field: fieldRect } = geometry
    const pointCenterX = pointRect.x + pointRect.width / 2
    assert.ok(tipRect.width >= 220, `expected a wide hover card, got ${String(tipRect.width)}px`)
    assert.ok(
      tipRect.x + tipRect.width <= fieldRect.x + fieldRect.width + 1,
      'hover card must stay inside the value-map fieldset',
    )
    assert.ok(tipRect.x + tipRect.width < pointCenterX, 'right-edge hover card must flip left')

    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'settings-usage-frontier-tooltip.png'))
  })
})
