import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedSubagentBadgeFixture } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

// Visual eval for the unified model-name display (AGENTS.md requires a visual
// eval for any UI-visible change). The subagent badge and the footer picker are
// the two most visible of the four surfaces the shared labeler owns: the badge
// used to write `session.model` verbatim for a cloud model, and the footer used
// to render the best-value sentinel inconsistently. Both now route through the
// one `displayModelLabel`, so a cloud subagent reads `Claude Haiku 4.5` and the
// footer reads `Best value (plan / price)` — the same forms every other surface
// shows. A screenshot is saved for review.
describe('subagent badge and footer model label', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedSubagentBadgeFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders the subagent badge through the shared labeler and captures a screenshot', async () => {
    await $('.tool-card-subagent').waitForExist({ timeout: 30_000 })

    // The badge is the whole point of local/cloud routing visibility; it used
    // to show the raw `claude-haiku-4-5` id. It now reads the house-style label.
    const badge = await $('.subagent-model')
    await badge.waitForExist({ timeout: 15_000 })
    await expect(badge).toHaveText('Claude Haiku 4.5')

    await saveElementScreenshot('.tool-card-subagent', 'subagent-badge-cloud.png')
  })

  it('renders the footer model through the shared labeler and captures a screenshot', async () => {
    // The footer picker trigger shows the active selection; the fixture pins
    // `auto:best-value`, which the shared labeler resolves to the sentinel label.
    const trigger = await $('.model-picker-trigger')
    await trigger.waitForExist({ timeout: 15_000 })
    await expect(trigger).toHaveText('Best value (plan / price)')

    await saveAppScreenshot('footer-model-label-best-value.png')
  })
})
