import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedContextWheelFixture, seedEmptyProject } from './helpers/seed-config.ts'
import { describeSkipInCi } from './helpers/ci-gate.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Heaviest seeded spec (seedContextWheelFixture + reloadSession): even at a
// "safe" 5th position in a 7-shard split it intermittently OOM-times-out on
// `.input-footer` and takes the runner down before the retry can recover.
// Skip in CI alongside the live-mock suite below until the per-spec Electron
// cleanup is fixed.
describeSkipInCi('context wheel footer seeded', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedContextWheelFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows neutral doughnut and percentage from seeded context snapshot', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed()
    await expect(wheel.$('.context-wheel-label')).toHaveText('30%')

    const fill = await wheel.$('.context-wheel-fill')
    const dash = await fill.getAttribute('stroke-dasharray')
    expect(dash).toBeTruthy()
    const filled = Number.parseFloat(dash!.split(' ')[0]!)
    expect(filled).toBeGreaterThan(0)

    await expect($('.footer-usage')).toHaveText('2.0k tokens')

    const footer = await $('.input-footer')
    await footer.saveScreenshot(join(SCREENSHOT_DIR, 'context-wheel-seeded-30pct.png'))
  })
})

describeSkipInCi('context wheel footer live mock', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-context-live-project', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('updates doughnut and tokens live during a mock agent run', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const textarea = await $('.prompt-input')
    await textarea.setValue('list files please')
    await $('.submit-btn').click()

    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed({ wait: 30_000 })
    await expect(wheel.$('.context-wheel-label')).toHaveText(/\d+%/)

    await expect($('.footer-usage')).toHaveText(/\d/, { wait: 30_000 })

    const footer = await $('.input-footer')
    await footer.saveScreenshot(join(SCREENSHOT_DIR, 'context-wheel-live-running.png'))
  })
})
