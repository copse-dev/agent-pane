import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('mock script multi-turn', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-mock-script-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('drives tool + text turns from natural prompts', async function () {
    this.timeout(60_000)
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    const scenario = await installMockScenario({
      title: 'Inspect the source directory',
      turns: [
        {
          user: 'Please list the src directory for me.',
          responses: [
            { toolCalls: [{ name: 'list_dir', args: { path: 'src' } }] },
            {
              text: 'I found the main application source files in src.',
              expectToolResults: [{ name: 'list_dir', includes: 'renderer' }],
            },
          ],
        },
        {
          user: 'Can you summarize what you found?',
          responses: [{ text: 'The src directory contains the main application sources.' }],
        },
      ],
    })

    await setComposerValue('Please list the src directory for me.')
    await $('.submit-btn').click()

    const listCard = await $('.tool-card[data-status="done"]')
    await listCard.waitForDisplayed({ timeout: 30_000 })
    await expect(listCard.$('.tool-name')).toHaveText('Listed directory')
    await waitForAgentIdle()
    await expectAssistantReply('I found the main application source files in src.')

    await waitForPromptReady()
    await setComposerValue('Can you summarize what you found?')
    await $('.submit-btn').click()
    await waitForAgentIdle(30_000)

    await browser.waitUntil(
      async () => {
        const texts = await $$('.msg-assistant .message-text').map((el) => el.getText())
        return texts.some((t) =>
          t.includes('The src directory contains the main application sources.'),
        )
      },
      {
        timeout: 15_000,
        timeoutMsg: 'expected the scripted summary reply',
      },
    )

    const userTexts = await $$('.msg-user .message-text').map((el) => el.getText())
    expect(userTexts).toEqual([
      'Please list the src directory for me.',
      'Can you summarize what you found?',
    ])
    const assistantTexts = await $$('.msg-assistant .message-text').map((el) => el.getText())
    expect(assistantTexts.filter(Boolean)).toEqual([
      'I found the main application source files in src.',
      'The src directory contains the main application sources.',
    ])

    await saveAppScreenshot('mock-script-multiturn.png')
    await scenario.assertComplete()
  })
})
