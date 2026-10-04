import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  seedPrPanelChatFixture,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * Visual eval for spinning a local thread off the PR viewer ("New thread"):
 * the composer draft is seeded with the PR markdown link while the checkout
 * control is left on its automatic policy — which, for this Git workspace with
 * the default `always` worktree mode, previews as an isolated worktree rather
 * than a forced shared checkout.
 */
describe('PR panel new thread (mock gh)', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    // The shared seed writer defaults projects to `never` so ordinary specs
    // cannot create real worktrees. This spec explicitly exercises isolation.
    seedPrPanelChatFixture(process.cwd(), { worktreeMode: 'always' })
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 }).getElement()
  })

  after(() => {
    resetUserData()
  })

  async function openPrTab(): Promise<void> {
    const pane = await $('#pane-files').getElement().getElement()
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click().getElement()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click().getElement()
    await browser.pause(800)
  }

  it('spins off an automatically isolated thread with the PR in the composer', async function () {
    this.timeout(120_000)

    await openPrTab()
    await browser.waitUntil(
      async () => {
        const el = await $('.pr-viewer-title').getElement().getElement()
        return (await el.isDisplayed()) && (await el.getText()).includes('Add GitHub PR panel tab')
      },
      { timeout: 15_000, timeoutMsg: 'expected auto-selected mock PR viewer' },
    )

    const newThreadBtn = await $('.pr-new-thread-btn').getElement()
    // New thread is a primary action beside the relationship overview; only
    // the additional lifecycle actions require opening More.
    await expect(await $('.pr-more-actions').getElement()).not.toHaveAttribute('open')
    await newThreadBtn.waitForDisplayed({ timeout: 10_000 })
    await expect(newThreadBtn).toHaveText('New thread')
    await saveElementScreenshot('#pane-files', 'pr-panel-new-thread-action.png')

    await newThreadBtn.click()

    // `.prompt-input` is contenteditable — assert via text, not input value.
    await expect(await $('.prompt-input').getElement().getElement()).toHaveText(
      expect.stringMatching(/#42.*copse-dev\/copse-panel\/pull\/42/s),
      { wait: 10_000 },
    )
    // No checkout preference is forced by "New thread": the footer previews the
    // automatic policy, which resolves to an isolated worktree here. The label
    // starts as the shared default and flips once the preview IPC resolves.
    await expect(await $('.footer-checkout-btn').getElement().getElement()).toHaveText('Isolated worktree', {
      wait: 10_000,
    })
    await expect(await $('.chat-row.selected .chat-title').getElement().getElement()).toHaveText(
      expect.stringMatching(/^PR #42:/),
    )

    await saveElementScreenshot('#app', 'pr-panel-new-thread-composer.png')
  })
})
