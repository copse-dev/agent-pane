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
 * Drives the PR-pane lifecycle action buttons (Rerun CI / Approve / Mark ready /
 * Enable auto-merge) against the mock GitHub backend and captures screenshots of
 * each state transition. `COPSE_PANEL_MOCK_GH_ACTIONS=1` seeds the linked PR (#42)
 * as a draft so mark-ready has a real draft → ready transition to show.
 */
describe('PR panel lifecycle actions (mock gh)', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({
      COPSE_PANEL_MOCK_GH: '1',
      COPSE_PANEL_MOCK_GH_STATUS: 'ready',
      COPSE_PANEL_MOCK_GH_ACTIONS: '1',
    })
    resetUserData()
    seedPrPanelChatFixture(process.cwd())
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

  async function waitForViewer(title: string): Promise<void> {
    await browser.waitUntil(
      async () => {
        const el = await $('.pr-viewer-title')
        return (await el.isDisplayed()) && (await el.getText()).includes(title)
      },
      { timeout: 15_000, timeoutMsg: `expected PR viewer for "${title}"` },
    )
  }

  it('runs each PR lifecycle action against the mock backend', async function () {
    this.timeout(120_000)

    await openPrTab()
    // The linked PR (#42) auto-selects; under the actions fixture it is a draft.
    await waitForViewer('Add GitHub PR panel tab')
    await expect(await $('.pr-badge-draft')).toBeDisplayed()

    // Auto-approve the confirm() guard so the flow runs unattended.
    await browser.execute(() => {
      window.confirm = () => true
    })

    // All four action buttons are present for an open PR.
    await expect(await $('button.pr-action-btn*=Rerun CI')).toBeDisplayed()
    await expect(await $('button.pr-action-btn*=Approve')).toBeDisplayed()
    await expect(await $('button.pr-action-btn*=Mark ready')).toBeDisplayed()
    await expect(await $('button.pr-action-btn*=Enable auto-merge')).toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-actions-initial.png')

    // Approve → outcome message + Approved badge.
    await $('button.pr-action-btn*=Approve').click()
    await browser.waitUntil(async () => (await $('.pr-badge-approved')).isExisting(), {
      timeout: 15_000,
      timeoutMsg: 'expected Approved badge after approving',
    })
    await expect(await $('.pr-action-status')).toHaveText(expect.stringMatching(/approved pr #42/i))
    await saveElementScreenshot('#pane-files', 'pr-actions-approved.png')

    // Enable auto-merge → Auto-merge badge + strategy in the message.
    await $('button.pr-action-btn*=Enable auto-merge').click()
    await browser.waitUntil(async () => (await $('.pr-badge-automerge')).isExisting(), {
      timeout: 15_000,
      timeoutMsg: 'expected Auto-merge badge after enabling',
    })
    await expect(await $('.pr-action-status')).toHaveText(
      expect.stringMatching(/auto-merge \(squash\)/i),
    )
    await saveElementScreenshot('#pane-files', 'pr-actions-automerge.png')

    // Mark ready → the Draft badge disappears.
    await $('button.pr-action-btn*=Mark ready').click()
    await browser.waitUntil(async () => !(await $('.pr-badge-draft').isExisting()), {
      timeout: 15_000,
      timeoutMsg: 'expected Draft badge to clear after marking ready',
    })
    await expect(await $('.pr-action-status')).toHaveText(
      expect.stringMatching(/ready for review/i),
    )
    await saveElementScreenshot('#pane-files', 'pr-actions-ready.png')

    // Switch to the failing workspace PR (#88) and re-run its failed CI.
    await $('.pr-list-title*=Tidy up workspace status polling').click()
    await waitForViewer('Tidy up workspace status polling')
    await $('button.pr-action-btn*=Rerun CI').click()
    await browser.waitUntil(
      async () => /re-ran 1 failed run/i.test(await $('.pr-action-status').getText()),
      { timeout: 15_000, timeoutMsg: 'expected rerun outcome message' },
    )
    await saveElementScreenshot('#pane-files', 'pr-actions-rerun.png')
  })
})
