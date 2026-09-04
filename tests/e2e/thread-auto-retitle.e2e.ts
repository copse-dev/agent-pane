import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('automatic thread re-titling', () => {
  before(async () => {
    resetUserData()
    const projectId = 'e2e-retitle-project'
    seedEmptyProject(process.cwd(), projectId, {
      model: 'claude-sonnet-4-6',
      smallTasksModel: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      nextStepSuggestionEnabled: false,
    })
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: 'e2e-retitle-thread',
          title: 'Initial UI Investigation',
          autoTitleCount: 1,
          model: 'claude-sonnet-4-6',
          status: 'idle',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'Investigate the login screen.',
              createdAt: 1700000000000,
            },
            {
              id: 'a1',
              role: 'assistant',
              content: 'The session handling needs investigation.',
              createdAt: 1700000000001,
            },
            {
              id: 'u2',
              role: 'user',
              content: 'Focus on authentication sessions.',
              createdAt: 1700000000002,
            },
            {
              id: 'a2',
              role: 'assistant',
              content: 'I will check the session lifecycle.',
              createdAt: 1700000000003,
            },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('updates an automatic title on the third user turn and preserves a manual rename', async function () {
    this.timeout(90_000)
    await $('.chat-row*=Initial UI Investigation').waitForExist({ timeout: 30_000 })
    await $('.chat-row*=Initial UI Investigation').click()
    await waitForPromptReady()
    await browser.execute(async () => {
      const bridge = (
        window as unknown as {
          __copseE2e: { setMockScript: (script: unknown) => Promise<unknown> }
        }
      ).__copseE2e
      await bridge.setMockScript([
        { when: 'Explain the session repair', text: 'The session repair is ready to review.' },
        { when: 'Reply with ONLY a concise 3-5 word title', text: 'Authentication Session Repair' },
      ])
    })
    await setComposerValue('Explain the session repair.')
    await $('.submit-btn').click()
    await $('.chat-row*=Authentication Session Repair').waitForExist({ timeout: 30_000 })
    await waitForAgentIdle()
    await saveElementScreenshot('#pane-projects', 'thread-auto-retitled.png')

    await browser.execute(() => {
      const title =
        document.querySelector('.chat-row.active .chat-title') ??
        document.querySelector('.chat-title')
      if (!title) throw new Error('thread title missing')
      title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    const input = $('.chat-title-rename')
    await input.waitForExist()
    await input.setValue('My Authentication Work')
    await browser.keys('Enter')
    await expect($('.chat-row*=My Authentication Work')).toExist()

    // Grow past the final auto-title threshold after a manual rename.
    for (let turn = 4; turn <= 8; turn++) {
      await waitForPromptReady()
      await setComposerValue(`Review session detail ${String(turn)}.`)
      await $('.submit-btn').click()
      await browser.waitUntil(async () =>
        browser.execute(
          (text) =>
            [...document.querySelectorAll('.msg-assistant .message-text')].some((element) =>
              element.textContent?.includes(text),
            ),
          `Mock response to: Review session detail ${String(turn)}.`,
        ),
      )
      await waitForAgentIdle()
    }
    await expect($('.chat-row*=My Authentication Work')).toExist()
    await saveElementScreenshot('#pane-projects', 'thread-manual-title-preserved.png')
  })
})
