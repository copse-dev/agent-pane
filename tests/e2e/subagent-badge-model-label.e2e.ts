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
// to render model selections inconsistently. Both now route through the one
// `displayModelLabel`, so a cloud subagent reads `Claude Haiku 4.5` and the
// footer resolves its dynamic selection to `Claude Sonnet 4.6` — the same forms
// every other surface shows. A screenshot is saved for review.
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
    const card = await $('.tool-card-subagent')
    await card.waitForExist({ timeout: 30_000 })
    await expect(card).not.toHaveAttribute('open')
    await card.$('summary.tool-card-header').click()
    await expect(card).toHaveAttribute('open')

    // The badge is the whole point of local/cloud routing visibility; it used
    // to show the raw `claude-haiku-4-5` id. It now reads the house-style label.
    const badge = await card.$('.subagent-model')
    await expect(badge).toBeDisplayed()
    await expect(badge).toHaveText('Claude Haiku 4.5')

    await saveElementScreenshot('.tool-card-subagent', 'subagent-badge-cloud.png')
  })

  it('renders the footer model through the shared labeler and captures a screenshot', async () => {
    // The footer picker trigger shows the concrete route used by a dynamic
    // selection. Best value is intentionally replaced by a local fallback in
    // footer chrome, so the fixture uses `auto:balanced` with a resolved cloud
    // route to exercise the shared labeler here.
    const trigger = await $('.model-picker-trigger')
    await trigger.waitForExist({ timeout: 15_000 })
    await expect(trigger).toHaveText('Claude Sonnet 4.6')

    await saveAppScreenshot('footer-model-label-resolved.png')
  })
})
