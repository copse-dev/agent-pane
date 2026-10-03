import assert from 'node:assert/strict'
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
import { assertKitButtonRow, measureKitButtonRow } from './helpers/kit-buttons.ts'
import { tokenColour } from './helpers/theme.ts'

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

  async function clickPrAction(label: string): Promise<void> {
    const action = await $(`button.pr-action-btn*=${label}`)
    if (!(await action.isDisplayed())) await $('.pr-more-toggle').click()
    await action.click()
    const confirm = await $('#confirm-dialog .confirm-dialog-confirm')
    await confirm.waitForDisplayed({ timeout: 10_000 })
    await confirm.click()
  }

  it('runs each PR lifecycle action against the mock backend', async function () {
    this.timeout(120_000)

    await openPrTab()
    // The linked PR (#42) auto-selects; under the actions fixture it is a draft.
    await waitForViewer('Add GitHub PR panel tab')
    await expect(await $('.pr-badge-draft')).toBeDisplayed()

    // Approve stays visible; secondary actions use the native disclosure.
    await expect(await $('button.pr-action-btn*=Rerun CI')).not.toBeDisplayed()
    await expect(await $('button.pr-action-btn*=Approve')).toBeDisplayed()
    await expect(await $('button.pr-action-btn*=Mark ready')).not.toBeDisplayed()
    await expect(await $('button.pr-action-btn*=Enable auto-merge')).not.toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-actions-initial.png')
    await $('.pr-more-toggle').click()
    await expect(await $('button.pr-action-btn*=Mark ready')).toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-actions-menu.png')
    await browser.keys('Escape')
    await expect(await $('.pr-more-toggle')).toBeFocused()
    await expect(await $('button.pr-action-btn*=Mark ready')).not.toBeDisplayed()

    // Approve → outcome message + Approved badge.
    await clickPrAction('Approve')
    await browser.waitUntil(async () => (await $('.pr-badge-approved')).isExisting(), {
      timeout: 15_000,
      timeoutMsg: 'expected Approved badge after approving',
    })
    await expect(await $('.pr-action-status')).toHaveText(expect.stringMatching(/approved pr #42/i))
    await saveElementScreenshot('#pane-files', 'pr-actions-approved.png')

    // Enable auto-merge → Auto-merge badge + strategy in the message.
    await clickPrAction('Enable auto-merge')
    await browser.waitUntil(async () => (await $('.pr-badge-automerge')).isExisting(), {
      timeout: 15_000,
      timeoutMsg: 'expected Auto-merge badge after enabling',
    })
    await expect(await $('.pr-action-status')).toHaveText(
      expect.stringMatching(/auto-merge \(squash\)/i),
    )
    await saveElementScreenshot('#pane-files', 'pr-actions-automerge.png')

    // Mark ready → the Draft badge disappears.
    await clickPrAction('Mark ready')
    await browser.waitUntil(async () => !(await $('.pr-badge-draft').isExisting()), {
      timeout: 15_000,
      timeoutMsg: 'expected Draft badge to clear after marking ready',
    })
    await expect(await $('.pr-action-status')).toHaveText(
      expect.stringMatching(/ready for review/i),
    )

    // Link actions (Open on GitHub, New thread) and lifecycle actions are compact
    // kit buttons in one --spacing-md row, not a `.pr-action-btn` stack (#3065).
    const row = assertKitButtonRow(await measureKitButtonRow('.pr-viewer-actions'), 'PR actions', {
      compact: true,
      minButtons: 2,
    })
    for (const button of row.buttons) {
      const expected = button.classes.includes('pr-action-btn')
        ? 'ui-btn-secondary'
        : 'ui-btn-ghost'
      assert.ok(button.classes.includes(expected), `"${button.label}" should be ${expected}`)
    }
    await saveElementScreenshot('#pane-files', 'pr-actions-ready.png')

    // Auto-merge is a setting, not a status: it keeps the neutral badge, while
    // the CI dots take the status tokens rather than their own hues.
    const automerge = await browser.execute(() => {
      const badge = document.querySelector('.pr-badge-automerge')
      if (!badge) return null
      const style = getComputedStyle(badge)
      return { color: style.color, border: style.borderTopColor }
    })
    assert.ok(automerge, 'expected the Auto-merge badge')
    assert.equal(automerge.color, await tokenColour('--text-secondary'))
    assert.equal(automerge.border, await tokenColour('--border', 'border-top-color'))
    // #3477 lifecycle/conflict SVGs remain intact in the redesigned rows.
    await expect(
      await $('.pr-list-status.is-open.has-ci-failure svg[data-icon="git-pull-request"]'),
    ).toBeDisplayed()
    await expect(await $('.pr-list-ci')).not.toBeExisting()

    // Switch to the failing workspace PR (#88) and re-run its failed CI.
    await $('.pr-list-title*=Tidy up workspace status polling').click()
    await waitForViewer('Tidy up workspace status polling')
    await clickPrAction('Rerun CI')
    await browser.waitUntil(
      async () => /re-ran 1 failed run/i.test(await $('.pr-action-status').getText()),
      { timeout: 15_000, timeoutMsg: 'expected rerun outcome message' },
    )
    await saveElementScreenshot('#pane-files', 'pr-actions-rerun.png')
  })
})
