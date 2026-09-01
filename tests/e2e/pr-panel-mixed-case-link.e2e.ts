import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'

describe('PR panel mixed-case GitHub identity', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    const projectId = 'e2e-pr-mixed-case-project'
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: 'mixed-case-link',
      [`threads:${projectId}`]: [
        {
          id: 'mixed-case-link',
          title: 'Mixed-case PR link',
          status: 'idle',
          messages: [
            {
              id: 'mixed-case-message',
              role: 'assistant',
              content:
                'Track [PR #42](https://github.com/Copse-Dev/Copse-Panel/pull/42) for review.',
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'agent-owner',
          title: 'Agent owner',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          remoteAgentLink: {
            provider: 'cursor',
            agentId: 'mixed-case-agent',
            prUrl: 'https://github.com/copse-dev/copse-panel/pull/42',
            repo: 'copse-dev/copse-panel',
            createdAt: now - 1_000,
          },
          createdAt: now - 1_000,
          updatedAt: now - 1_000,
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

  it('enriches and agent-links a differently cased chat URL as one PR', async function () {
    this.timeout(120_000)
    const pane = await $('#pane-files')
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click()

    const linked = await $('.pr-list-row[data-pr-section="linked"]')
    await linked.waitForDisplayed({ timeout: 15_000 })
    await expect(linked.$('.pr-list-title')).toHaveText('Add GitHub PR panel tab')
    await expect(linked.$('.pr-list-agent-badge')).toBeDisplayed()
    await expect($$('.pr-list-row')).toBeElementsArrayOfSize(2)

    await saveElementScreenshot('#pane-files', 'pr-panel-mixed-case-link.png')
  })
})
