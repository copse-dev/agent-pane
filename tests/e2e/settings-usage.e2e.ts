import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { getCopseUserDataDir } from './helpers.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareE2eScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('settings usage panel', () => {
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
    assert.equal(plan.providers.length, 2)
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
    await expect($('.usage-plan-bar')).toBeDisplayed()
    await expect($('.usage-period-body .usage-headline')).toBeDisplayed()
    await expect($('.usage-model-group:nth-of-type(1) tbody tr')).toBeDisplayed()
    await expect($('.usage-model-group:nth-of-type(2) tbody tr')).toBeDisplayed()

    await prepareE2eScreenshot()
    await saveElementScreenshot('#settings-dialog', 'settings-usage-plan-limits.png')
  })
})
