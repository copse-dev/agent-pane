import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('concurrent OpenRouter pricing snapshots', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const now = Date.now()
    seedEmptyProject(process.cwd(), 'e2e-concurrent-openrouter-pricing', {
      usageEvents: [
        {
          at: now,
          model: 'openrouter:vendor/first',
          source: 'agent',
          inputTokens: 1_000_000,
          outputTokens: 0,
          threadId: 'thread-1',
          projectId: 'e2e-concurrent-openrouter-pricing',
        },
        {
          at: now,
          model: 'openrouter:vendor/second',
          source: 'agent',
          inputTokens: 1_000_000,
          outputTokens: 0,
          threadId: 'thread-1',
          projectId: 'e2e-concurrent-openrouter-pricing',
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('prices models learned by overlapping catalog refreshes', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const pricing = await browser.execute(async () => {
      const bridge = (
        window as unknown as {
          __copseE2e?: {
            rememberOpenRouterPricingBatches: (batches: unknown) => Promise<unknown>
          }
        }
      ).__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      return bridge.rememberOpenRouterPricingBatches([
        [{ id: 'vendor/first', inputPricePerMTok: 1, outputPricePerMTok: 2 }],
        [{ id: 'vendor/second', inputPricePerMTok: 3, outputPricePerMTok: 4 }],
      ])
    })
    assert.equal(typeof pricing, 'object')

    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const usage = $('.usage-period-body')
    await expect(usage).toBeDisplayed()
    await browser.waitUntil(
      async () => {
        const text = await usage.getText()
        return (
          text.includes('openrouter:vendor/first') &&
          text.includes('openrouter:vendor/second') &&
          text.includes('~$1.00') &&
          text.includes('~$3.00')
        )
      },
      { timeout: 15_000, timeoutMsg: 'both OpenRouter rows were not priced' },
    )

    await browser.execute(() => {
      document.querySelector('.usage-period-body')?.scrollIntoView({ block: 'center' })
    })
    await browser.pause(100)
    await saveElementScreenshot('.usage-period-body', 'settings-concurrent-openrouter-pricing.png')
  })
})
