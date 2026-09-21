import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { waitForAgentIdle } from './helpers.ts'

// Visual eval for #515: the ask_user tool blocks the agent loop on a modal dialog
// until the user answers. Component tests cover DOM behaviour; this spec exercises
// the full Electron path from a natural request through tool, IPC, dialog, and response.
describe('ask_user dialog', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-ask-user-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows the modal with options and returns the answer to the agent', async () => {
    const scenario = await installMockScenario({
      title: 'Sign in to Claude',
      turns: [
        {
          user: 'Help me sign in to Claude.',
          responses: [
            {
              toolCalls: [
                {
                  name: 'ask_user',
                  args: {
                    questions: [
                      {
                        question:
                          'Claude is not signed in. Run `claude /login` in a terminal, then re-send your message.',
                        options: ['Run `claude /login`', 'Not now'],
                      },
                    ],
                  },
                },
              ],
            },
            {
              text: 'Run the login command in your terminal, then send your message again.',
              expectToolResults: [{ name: 'ask_user', includes: 'Run claude /login' }],
            },
          ],
        },
      ],
    })
    await setComposerValue('Help me sign in to Claude.')
    await $('.submit-btn').click()

    const dialog = await $('#ask-user-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.ask-user-question code')).toHaveText('claude /login')
    await expect(dialog.$('.ask-user-question')).not.toHaveText(expect.stringContaining('`'))

    const option = await dialog.$('.ask-user-option*=Run')
    await expect(option.$('code')).toHaveText('claude /login')
    await saveElementScreenshot('#ask-user-dialog', 'ask-user-dialog.png')
    await option.click()

    const input = await dialog.$('.ask-user-input')
    await expect(input).toHaveValue('Run claude /login')

    await dialog.$('.ask-user-submit').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })

    // The selected option is returned through the real tool result before the
    // scripted continuation is emitted.
    await waitForAgentIdle(30_000)
    await expectAssistantReply(
      'Run the login command in your terminal, then send your message again.',
    )
    await scenario.assertComplete()
  })

  it('dismisses the modal when the originating run is stopped', async () => {
    await prepareMockToolTurn(
      'Ask whether we should keep waiting.',
      { name: 'ask_user', args: { questions: [{ question: 'Should this run keep waiting?' }] } },
      'The waiting decision is recorded above.',
      true,
    )
    await $('.submit-btn').click()

    const dialog = await $('#ask-user-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(async () => await $('.stop-btn').isDisplayed(), {
      timeout: 10_000,
      timeoutMsg: 'expected Stop while ask_user blocks the run',
    })

    await browser.execute(async () => {
      const [threadId] = await window.api.agent.runningThreadIds()
      if (!threadId) throw new Error('expected a running ask_user thread')
      await window.api.agent.abort(threadId)
    })

    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await expect(dialog).not.toBeDisplayed()
    await saveAppScreenshot('ask-user-dialog-cancelled.png')
  })
})
