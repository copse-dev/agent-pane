import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
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

  it('replaces the repo fallback for a PR absent from the open-list pools', async function () {
    this.timeout(120_000)
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click()

    const linkedTitle = await $('.pr-list-row[data-pr-section="linked"] .pr-list-title')
    await expect(linkedTitle).toHaveText('Ship sidebar thread PR status')
    await expect(linkedTitle).not.toHaveText('copse-dev/copse-panel')
    await saveElementScreenshot('#pane-files', 'pr-panel-chat-only-title.png')
  })
})
