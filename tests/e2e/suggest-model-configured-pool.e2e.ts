import { $, browser, expect } from '@wdio/globals'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { savePreparedElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-suggest-model'

// The user has set up OpenAI only. The recommendation must come from that
// configured pool, not from the shipped catalog's Anthropic representatives.
describe('suggest_model recommends only configured models', () => {
  before(async () => {
    resetUserData()
    const workspace = seedStableWorkspace()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspace, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
    })
    writeSettings({
      modelClassifierEnabled: true,
      subagentsEnabled: false,
      apiKey: {
        openai: { v: 1, enc: Buffer.from('sk-e2e-openai', 'utf8').toString('base64'), plain: true },
      },
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('shows an OpenAI recommendation in the tool card', async function () {
    this.timeout(90_000)
    const prompt = 'Which model should fix the README typo?'
    const reply = 'A small configured OpenAI model is enough for the README typo.'
    const scenario = await installMockScenario({
      title: 'Suggest a model',
      turns: [
        {
          user: prompt,
          responses: [
            {
              toolCalls: [{ name: 'suggest_model', args: { task: 'Fix the typo in README.md' } }],
            },
            {
              text: reply,
              expectToolResults: [{ name: 'suggest_model', includes: 'Recommended model: gpt-' }],
            },
          ],
        },
      ],
    })

    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle()
    await expectAssistantReply(reply)
    await scenario.assertComplete()

    // The turn's tool rollup and the card inside it both start collapsed.
    const rollup = $('.tool-card-rollup*=Suggest model')
    await rollup.waitForExist({ timeout: 10_000 })
    await rollup.$('summary').click()
    const card = rollup.$('.tool-rollup-body .tool-card[data-tool-id]')
    await card.$('summary').click()
    const result = card.$('.tool-result')
    await result.waitForDisplayed({ timeout: 10_000 })
    await expect(result).toHaveText(expect.stringContaining('Recommended model: gpt-'))
    await expect(result).not.toHaveText(expect.stringContaining('claude-'))
    await expect(result).toHaveText(
      expect.stringContaining('Advisory: the model in use is unchanged.'),
    )

    const messageId = await rollup.parentElement().getAttribute('data-message-id')
    if (!messageId) throw new Error('suggest_model card has no owning message')
    await savePreparedElementScreenshot(
      `[data-message-id="${messageId}"]`,
      'suggest-model-configured-pool.png',
    )
  })
})
