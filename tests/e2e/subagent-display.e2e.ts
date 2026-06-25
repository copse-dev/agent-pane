import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { resetUserData, seedSubagentFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Thin VISUAL smoke for the subagent tool card. The DOM contract (collapsed
// "Explore files" header, the expanded explore message + nested "Read file"
// label) is asserted without Electron in
// src/renderer/views/subagent-display.test.ts; this spec exists only to render
// the seeded card and capture the collapsed / expanded reference screenshots for
// human review. The former `live mock` describe — a heavy multi-turn explore run
// that OOM-crashed the constrained CI runner, which is why this file was
// quarantined — is intentionally dropped, so the lightweight seeded render can
// run un-quarantined.
describe('subagent display (visual reference)', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedSubagentFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('captures the collapsed and expanded subagent card', async () => {
    const card = await $('.tool-card-subagent')
    await card.waitForExist({ timeout: 30_000 })
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'subagent-display-collapsed.png'))

    await card.$('summary.tool-card-header').click()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'subagent-display-expanded.png'))
  })
})
