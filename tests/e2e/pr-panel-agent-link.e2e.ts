import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  seedPrPanelAgentLinkFixture,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

// Visual eval for the agent-owned PR affordances (issue #690, Q6): a thread that
// launched a cloud agent which opened a PR gets a 🤖 badge on that PR's row and
// an "open agent thread" action in the viewer.
describe('PR panel agent-owned PR (mock gh)', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    seedPrPanelAgentLinkFixture(process.cwd())
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  async function openPrTab(): Promise<void> {
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click()
    await browser.pause(800)
  }

  it('badges the agent-opened PR and offers an open-thread action', async function () {
    this.timeout(120_000)

    await openPrTab()

    // The chat-linked PR #42 is also recorded as agent-owned, so its row shows
    // the agent badge with a provider-named tooltip.
    const badge = await $('.pr-list-row[data-pr-section="linked"] .pr-list-agent-badge')
    await badge.waitForDisplayed({ timeout: 15_000 })
    expect(await badge.getAttribute('title')).toMatch(/opened by a cursor agent/i)

    // Selecting the PR surfaces the "open agent thread" jump in the viewer meta.
    await $('.pr-list-row[data-pr-section="linked"]').click()
    const openThreadBtn = await $('.pr-open-thread-btn')
    await openThreadBtn.waitForDisplayed({ timeout: 15_000 })
    expect(await openThreadBtn.getText()).toMatch(/open cursor agent thread/i)

    await saveElementScreenshot('#pane-files', 'pr-panel-agent-owned.png')
  })
})
