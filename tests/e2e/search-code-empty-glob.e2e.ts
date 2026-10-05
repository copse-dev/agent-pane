import { realpathSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

describe('search code empty glob guidance', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(
      realpathSync(
        seedStableWorkspace({
          files: {
            'src/auth.ts': 'export function authenticate() {}\n',
            'src/view.tsx': 'export const other = 1\n',
            'outside/auth.ts': 'export function authenticate() {}\n',
          },
        }),
      ),
      'search-code-glob-project',
      { subagentsEnabled: false, model: 'claude-sonnet-4-6' },
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders a scoped retry explanation for real matches excluded by the glob', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const prompt = 'Find the authentication function in the source TSX files.'
    const explanation =
      'The pattern does match outside that glob (e.g. src/auth.ts); retry without file_glob or widen it.'
    const reply =
      'The function is in a TypeScript file; widen the source file filter to include it.'
    // Exercise the actual tool producer and renderer with ordinary ripgrep.
    // Real no-ripgrep producer behavior is covered separately by search-tools units.
    const scenario = await installMockScenario({
      title: 'Find authentication code',
      turns: [
        {
          user: prompt,
          responses: [
            {
              toolCalls: [
                {
                  name: 'search_code',
                  args: { pattern: 'authenticate', path: 'src', file_glob: '*.tsx' },
                },
              ],
            },
            { text: reply, expectToolResults: [{ name: 'search_code', includes: explanation }] },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle(30_000)
    await expectAssistantReply(reply)
    await scenario.assertComplete()

    const rollup = $('.tool-card-rollup[data-status="done"]')
    await rollup.waitForDisplayed({ timeout: 10_000 })
    if (!(await rollup.getProperty('open'))) {
      await rollup.$('summary.tool-card-header').click()
    }
    const card = $('.tool-card[data-tool-id][data-status="done"]')
    await card.waitForDisplayed({ timeout: 10_000 })
    if (!(await card.getProperty('open'))) {
      await card.$('summary.tool-card-header').click()
    }
    const result = card.$('.tool-result')
    await expect(result).toBeDisplayed()
    await expect(result).toHaveText('No matches found within file_glob "*.tsx".', {
      containing: true,
    })
    await expect(result).toHaveText(explanation, { containing: true })
    expect(await result.getText()).not.toContain('outside/auth.ts')
    await saveElementScreenshot(
      '.tool-card[data-tool-id][data-status="done"]',
      'search-code-empty-glob.png',
    )
  })
})
