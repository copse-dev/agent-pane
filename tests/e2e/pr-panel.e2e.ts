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

describe('PR panel (mock gh)', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
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
    await $('[aria-label="Pull requests"]').click()
    await browser.pause(800)
  }

  it('captures mock PR panel screenshots and DOM assertions', async function () {
    this.timeout(120_000)

    await openPrTab()

    await browser.waitUntil(async () => (await $$('.pr-list-row')).length >= 2, {
      timeout: 15_000,
      timeoutMsg: 'expected linked and open PR rows',
    })

    await expect(await $('.git-changes-section-title*=From chat')).toHaveText(
      expect.stringMatching(/from chat \(1\)/i),
    )
    await expect(await $('.git-changes-section-title*=Your open PRs')).toHaveText(
      expect.stringMatching(/your open prs \(1\)/i),
    )
    await expect(await $('.pr-list-row[data-pr-section="linked"] .pr-list-title')).toHaveText(
      'Add GitHub PR panel tab',
    )

    await browser.waitUntil(
      async () => {
        const title = await $('.pr-viewer-title')
        return (
          (await title.isDisplayed()) && (await title.getText()).includes('Add GitHub PR panel tab')
        )
      },
      { timeout: 15_000, timeoutMsg: 'expected auto-selected mock PR viewer' },
    )

    await saveElementScreenshot('#pane-files', 'pr-panel-linked-list.png')
    await expect(await $('.pr-viewer-description')).toHaveText(expect.stringContaining('PRs'))
    await saveElementScreenshot('#pane-files', 'pr-panel-viewer.png')

    await $('[aria-label="Explorer"]').click()
    await browser.pause(200)
    await (await $('[data-message-id="msg-assistant-pr-link"] .message-text a')).click()
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () =>
            document.querySelector('[aria-label="Pull requests"].is-active') != null &&
            document.querySelector('.pr-viewer-title')?.textContent === 'Add GitHub PR panel tab',
        ),
      { timeout: 10_000, timeoutMsg: 'expected chat PR link to open mock PR viewer' },
    )

    await $('.titlebar-settings-btn').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
    await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const fieldset = [...document.querySelectorAll<HTMLFieldSetElement>('fieldset')].find(
        (candidate) => candidate.querySelector('legend')?.textContent?.trim() === 'GitHub CLI',
      )
      if (!content || !fieldset) return
      content.scrollTop = Math.max(0, fieldset.offsetTop - 24)
    })
    await browser.pause(200)
    await expect(await $('.gh-cli-status')).toHaveText(
      expect.stringMatching(/signed in as @mock-user/i),
    )
    await saveElementScreenshot('#settings-dialog', 'pr-panel-settings-gh-cli.png')
    await $('.settings-close-btn').click()
  })
})
