import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

/**
 * Classifier calls in Settings → Usage: listed by connection and model with
 * their own table, counted in no cloud or local model row and adding nothing to
 * cost. The ledger is seeded; the tool, background and Test callers that write
 * it are covered by their own tests and by settings-classifiers-install.e2e.ts.
 */
describe('settings usage lists classifier calls', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const at = Date.now() - 60_000
    const classifier = (
      provider: string,
      model: string,
      inputTokens: number,
      outputTokens: number,
    ): {
      at: number
      model: string
      source: 'classifier'
      provider: string
      inputTokens: number
      outputTokens: number
    } => ({ at, model, source: 'classifier', provider, inputTokens, outputTokens })
    seedEmptyProject(process.cwd(), 'e2e-usage-classifiers', {
      usageEvents: [
        {
          at,
          model: 'claude-sonnet-4-6',
          source: 'agent',
          inputTokens: 52_000,
          outputTokens: 4_100,
          threadId: 'thread-1',
          projectId: 'e2e-usage-classifiers',
        },
        classifier('Kev (local)', 'kev-4b', 9_800, 31),
        classifier('Kev (local)', 'kev-4b', 2_600, 8),
        classifier('TypeSafe / Jev', 'jev-1', 61_500, 220),
        // A background question served by the same connection, as a different model.
        classifier('Kev (local)', 'kev-4b-r2', 1_200, 4),
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  async function openUsage(): Promise<void> {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    await $('.usage-period-body .usage-headline').waitForDisplayed({ timeout: 15_000 })
  }

  it('shows each connection and model with calls and tokens, apart from chat models', async () => {
    const summary = (await browser.execute(() => window.api.usage.getSummary())) as {
      day: { classifiers: Array<{ provider: string; model: string; calls: number }> }
    }
    assert.deepEqual(
      summary.day.classifiers.map((row) => [row.provider, row.model, row.calls]),
      [
        ['TypeSafe / Jev', 'jev-1', 1],
        ['Kev (local)', 'kev-4b', 2],
        ['Kev (local)', 'kev-4b-r2', 1],
      ],
    )

    await openUsage()
    const table = $('.usage-classifier-table')
    await table.waitForDisplayed()
    await expect($('.usage-classifier-group h4')).toHaveText('Classifiers')
    const rows = await browser.execute(() =>
      [...document.querySelectorAll('.usage-classifier-table tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''),
      ),
    )
    assert.deepEqual(rows, [
      ['TypeSafe / Jev', 'jev-1', '1', '61.5k', '220'],
      ['Kev (local)', 'kev-4b', '2', '12.4k', '39'],
      ['Kev (local)', 'kev-4b-r2', '1', '1.2k', '4'],
    ])

    // Chat-model tables hold only chat models: a classifier is not "unpriced cloud usage".
    const modelTables = await browser.execute(() =>
      [...document.querySelectorAll('.usage-model-group:not(.usage-classifier-group)')].map(
        (group) => group.textContent ?? '',
      ),
    )
    assert.ok(modelTables.some((text) => text.includes('claude-sonnet-4-6')))
    assert.equal(
      modelTables.some((text) => /kev-4b|jev-1/.test(text)),
      false,
    )
    const headline = await $('.usage-period-body .usage-headline').getText()
    assert.doesNotMatch(headline, /Cost unavailable|Known cost/)
    await saveElementScreenshot('.usage-classifier-group', 'settings-usage-classifiers.png')
  })

  it('lists classifier calls in the day, month and 90-day windows and explains All time', async () => {
    for (const period of ['month', 'period90d'] as const) {
      await $(`.usage-period-btn[data-period="${period}"]`).click()
      await browser.waitUntil(
        async () => (await $$('.usage-classifier-table tbody tr')).length === 3,
        { timeout: 10_000, timeoutMsg: `${period} did not list the classifier calls` },
      )
    }
    await $('.usage-period-btn[data-period="allTime"]').click()
    await expect($('.usage-classifier-group .usage-empty')).toHaveText(
      expect.stringContaining('day, month and 90-day windows only'),
    )
    assert.equal(await $('.usage-classifier-table').isExisting(), false)
    await saveElementScreenshot(
      '.usage-classifier-group',
      'settings-usage-classifiers-all-time.png',
    )
  })
})
