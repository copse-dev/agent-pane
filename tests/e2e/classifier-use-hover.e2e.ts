import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedClassifierCalls,
  seedContextWheelFixture,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// The footer hover reports what the classifiers did for the thread: how many
// screenings, what they decided, how long they took and what they cost. The
// numbers come from `classifier-call` lines on the thread's decision log, read
// over `usage:get-thread-classifier-use`, so this seeds real spine lines rather
// than faking the IPC.
describe('footer classifier use hover', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedContextWheelFixture(process.cwd())
    seedClassifierCalls('e2e-context-wheel-project', 'e2e-context-wheel-thread', [
      {
        subject: 'shell-scope',
        engine: 'Kev 4B',
        label: 'sandbox',
        latencyMs: 800,
        count: 15,
        inputTokens: 120,
        outputTokens: 4,
      },
      { subject: 'shell-scope', engine: 'Kev 4B', label: 'external', latencyMs: 1200, count: 3 },
      { subject: 'terminal-read', engine: 'Winnow 12B', label: 'safe', latencyMs: 1400, count: 5 },
      { subject: 'terminal-read', engine: 'Winnow 12B', label: null, latencyMs: 1400, count: 1 },
    ])
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('lists each classifier with its verdicts, latency and tokens beneath usage', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })
    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed()

    await browser.pause(500)
    await wheel.moveTo()
    const popover = wheel.$('.context-wheel-popover')
    await expect(popover).toBeDisplayed()

    // The report is fetched asynchronously after the thread opens.
    await browser.waitUntil(
      async () => (await popover.getText()).includes('Classifiers · 24 calls'),
      { timeoutMsg: 'expected the classifier section to load' },
    )
    const text = await popover.getText()
    expect(text).toMatch(/Shell guard/)
    // (15 × 800ms + 3 × 1200ms) / 18 calls; only the 15 sandbox calls carried tokens.
    expect(text).toMatch(/Kev 4B · 867ms avg · 1\.8k in \/ 60 out/)
    expect(text).toMatch(/18 calls/)
    expect(text).toMatch(/Terminal read screen/)
    expect(text).toMatch(/Winnow 12B · 1\.4s avg/)
    expect(text.indexOf('Usage ·')).toBeLessThan(text.indexOf('Classifiers ·'))

    await expect(popover.$$('.footer-usage-popover-row.is-classifier')).toBeElementsArrayOfSize(2)
    const labels = await browser.execute(() =>
      [...document.querySelectorAll('.context-wheel-popover .footer-usage-popover-pill')].map(
        (pill) => pill.textContent ?? '',
      ),
    )
    expect(labels).toEqual(['15 sandbox', '3 external', '5 safe', '1 no verdict'])

    await saveAppScreenshot('classifier-use-hover.png')
  })
})
