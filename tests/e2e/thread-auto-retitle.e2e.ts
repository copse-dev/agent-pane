import { installMockScenario, prepareMockTurn } from './helpers/mock-scenario.ts'
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
    await installMockScenario({
      title: 'Authentication session repair',
      turns: [
        {
          user: 'Explain the session repair.',
          responses: [{ text: 'The session repair is ready to review.' }],
        },
      ],
    })
    await setComposerValue('Explain the session repair.')
    await $('.submit-btn').click()
    let observedTitles: string[] = []
    try {
      await browser.waitUntil(
        async () => {
          observedTitles = await browser.execute(() =>
            [...document.querySelectorAll('.chat-row .chat-title')].map(
              (element) => element.textContent?.trim() ?? '',
            ),
          )
          return observedTitles.includes('Authentication session repair')
        },
        { timeout: 30_000, interval: 250 },
      )
    } catch {
      throw new Error(
        `Expected the generated title; observed sidebar titles: ${JSON.stringify(observedTitles)}`,
      )
    }
    await waitForAgentIdle()
    await saveElementScreenshot('#pane-projects', 'thread-auto-retitled.png')

    await browser.execute(() => {
      const title = document.querySelector('.chat-row.selected .chat-title')
      if (!title) throw new Error('thread title missing')
      title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      // Keep the edit in one browser task: WebDriver can steal focus between
      // setValue calls on Linux, blurring and committing this transient input.
      const input = document.querySelector<HTMLInputElement>('.chat-title-rename')
      if (!input) throw new Error('rename input missing')
      input.value = 'My Authentication Work'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    await expect($('.chat-row*=My Authentication Work')).toExist()

    // Grow past the final auto-title threshold after a manual rename.
    for (let turn = 4; turn <= 8; turn++) {
      await waitForPromptReady()
      await prepareMockTurn(`Review session detail ${String(turn)}.`, [
        { text: `Session detail ${String(turn)} has been reviewed.` },
      ])
      await $('.submit-btn').click()
      await browser.waitUntil(async () =>
        browser.execute(
          (text) =>
            [...document.querySelectorAll('.msg-assistant .message-text')].some((element) =>
              element.textContent?.includes(text),
            ),
          `Session detail ${String(turn)} has been reviewed.`,
        ),
      )
      await waitForAgentIdle()
    }
    await expect($('.chat-row*=My Authentication Work')).toExist()
    await saveElementScreenshot('#pane-projects', 'thread-manual-title-preserved.png')
  })
})
