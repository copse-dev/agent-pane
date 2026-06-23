import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('composer context breakdown wheel', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-context-breakdown-project', { subagentsEnabled: false })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the default-context breakdown ring on a fresh thread', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const wheel = await $('.context-wheel')
    await wheel.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(
      async () => (await wheel.getAttribute('class'))?.includes('has-breakdown') ?? false,
      { timeout: 30_000, timeoutMsg: 'expected breakdown ring on fresh thread' },
    )

    await expect(wheel.$('.context-wheel-label')).toHaveText(/\d+%/)
    const arcs = await $$('.context-wheel g circle')
    expect(arcs.length).toBeGreaterThanOrEqual(2)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'context-breakdown-default.png'))
  })

  it('adds a "Your message" segment and reveals the hover breakdown', async () => {
    const textarea = await $('.prompt-input')
    await textarea.setValue('Please refactor the agent service to extract a helper module.')

    const wheel = await $('.context-wheel')
    await wheel.moveTo()

    const popover = await $('.context-wheel-popover')
    await popover.waitForDisplayed({ timeout: 5_000 })

    await expect(popover).toHaveText(/System prompt/)
    await expect(popover).toHaveText(/Your message/)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'context-breakdown-popover.png'))
  })
})
