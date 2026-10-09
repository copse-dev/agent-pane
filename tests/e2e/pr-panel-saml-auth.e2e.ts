import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('PR organization SAML authorization', () => {
  before(async function () {
    this.timeout(120_000)
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    const now = Date.now()
    const projectId = 'e2e-pr-saml-project'
    const threadId = 'e2e-pr-saml-thread'
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'PR needs SSO',
          status: 'idle',
          messages: [
            {
              id: 'msg-pr-saml',
              role: 'user',
              content: 'Review https://github.com/duckduckgo/privacy-configuration/pull/6059',
              toolCalls: [],
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

  it('shows a safe authorization button for a SAML-protected PR', async () => {
    const pane = await $('#pane-files').getElement()
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click()
    const row = await $('.pr-list-row[data-pr-section="linked"]').getElement()
    await row.waitForDisplayed({ timeout: 20_000 })
    await row.click()

    const button = await $('#pr-viewer-host .pr-auth-button').getElement()
    await button.waitForDisplayed({ timeout: 20_000 })
    await expect(button).toHaveText('Sign in with GitHub SSO')
    await expect($('#pr-viewer-host .pr-auth-error')).toHaveText(
      'GitHub requires SSO authorization for duckduckgo.',
      { containing: true },
    )
    const viewerText = await $('#pr-viewer-host').getText()
    expect(viewerText).not.toContain('mock-authorization-value')
    await saveElementScreenshot('#pane-files', 'pr-panel-saml-auth.png')
  })
})
