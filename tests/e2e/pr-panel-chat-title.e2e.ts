import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'

describe('PR panel chat-only title enrichment', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    const projectId = 'e2e-pr-chat-title-project'
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: 'chat-only-pr',
      [`threads:${projectId}`]: [
        {
          id: 'chat-only-pr',
          title: 'Chat-only PR title',
          status: 'idle',
          messages: [
            {
              id: 'chat-only-pr-message',
              role: 'assistant',
              content:
                'The merged change is [PR #99](https://github.com/copse-dev/copse-panel/pull/99).',
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows the PR title on hover and still opens the PR on click', async function () {
    this.timeout(120_000)
    const link = await $('[data-message-id="chat-only-pr-message"] a[href*="/pull/99"]')
    await link.waitForDisplayed({ timeout: 15_000 })
    await link.moveTo()

    const card = await $('.pr-link-preview')
    await card.waitForDisplayed({ timeout: 15_000 })
    await expect(card.$('.pr-link-preview-title')).toHaveText('Ship sidebar thread PR status')
    await expect(card.$('.pr-link-preview-meta')).toHaveText('Pull request #99')
    const placement = await browser.execute(() => {
      const preview = document.querySelector<HTMLElement>('.pr-link-preview')
      if (!preview) throw new Error('PR preview missing')
      const rect = preview.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    expect(placement.left).toBeGreaterThanOrEqual(0)
    expect(placement.top).toBeGreaterThanOrEqual(0)
    expect(placement.right).toBeLessThanOrEqual(1280)
    expect(placement.bottom).toBeLessThanOrEqual(800)
    await saveAppScreenshot('pr-link-title-hover.png')

    await link.click()
    await expect($('.pr-viewer-title')).toHaveText('Ship sidebar thread PR status')
    await expect(card).not.toBeDisplayed()
  })

  it('replaces the repo fallback for a PR absent from the open-list pools', async function () {
    this.timeout(120_000)
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    const linkedTitle = await $('.pr-list-row[data-pr-section="linked"] .pr-list-title')
    if (!(await linkedTitle.isDisplayed())) {
      await $('[aria-label="Open pull requests"]').click()
    }
    await expect(linkedTitle).toHaveText('Ship sidebar thread PR status')
    await expect(linkedTitle).not.toHaveText('copse-dev/copse-panel')
    await saveElementScreenshot('#pane-files', 'pr-panel-chat-only-title.png')
  })
})
