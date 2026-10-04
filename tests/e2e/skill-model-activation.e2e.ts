import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// Real native agent/tool/transcript path; the scripted provider makes selection deterministic.
// This proves activation wiring and attribution, not real-model selection quality.
describe('model-selected skill activation', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(
      seedStableWorkspace({
        files: {
          '.cursor/skills/style-guide/SKILL.md':
            '---\nname: style-guide\ndescription: Explain the project style guide\n---\n\nUse clear, concise project documentation.',
          '.cursor/skills/unrelated-helper/SKILL.md':
            '---\nname: unrelated-helper\ndescription: Organize holiday photos\n---\n\nUNRELATED SKILL BODY',
          '.cursor/skills/manual-secret/SKILL.md':
            '---\nname: manual-secret\ndescription: A user-only helper\ndisable-model-invocation: true\n---\n\nMANUAL ONLY BODY',
        },
      }),
      'skill-activation-project',
      { model: 'claude-sonnet-4-6', subagentsEnabled: false },
    )
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('loads a selected skill without a slash command and visibly attributes and deduplicates it', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const prompt = 'Explain the project style guide.'
    const scenario = await installMockScenario({
      title: 'Automatic skill activation',
      turns: [
        {
          user: prompt,
          responses: [
            { toolCalls: [{ name: 'read_skill', args: { name: 'style-guide' } }] },
            {
              expectToolResults: [
                { name: 'read_skill', includes: 'Skill activated by the model: style-guide' },
              ],
              toolCalls: [
                { name: 'read_skill', args: { name: 'style-guide', path: './SKILL.md' } },
              ],
            },
            {
              expectToolResults: [{ name: 'read_skill', includes: 'already active in this turn' }],
              text: 'The style guide calls for clear, concise project documentation.',
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()
    const rollup = $('.tool-card-rollup')
    await rollup.waitForDisplayed({ timeout: 10_000 })
    if (!(await rollup.getProperty('open'))) await rollup.$('summary.tool-card-header').click()
    const cards = await $$('.tool-card[data-tool-id]')
    const first = cards[0]
    if (!first) throw new Error('No activation card rendered')
    await expect(first.$('.tool-name')).toHaveText('Activated skill style-guide')
    if (!(await first.getProperty('open'))) await first.$('summary.tool-card-header').click()
    await expect(first).toHaveText('Skill activated by the model: style-guide', {
      containing: true,
    })
    await expect(first).toHaveText('UNTRUSTED SOURCE', { containing: true })
    await expect(first).toHaveText('Context estimate: approximately', { containing: true })
    await expect(first).not.toHaveText('UNRELATED SKILL BODY', { containing: true })
    await expect(first).not.toHaveText('MANUAL ONLY BODY', { containing: true })
    await saveElementScreenshot(
      `.tool-card[data-tool-id="${await first.getAttribute('data-tool-id')}"]`,
      'skill-model-activation.png',
    )
  })

  it('rejects a guessed user-only skill through the real executor', async () => {
    const prompt = 'Try the user-only helper.'
    const scenario = await installMockScenario({
      title: 'Model invocation exclusion',
      turns: [
        {
          user: prompt,
          responses: [
            { toolCalls: [{ name: 'read_skill', args: { name: 'manual-secret' } }] },
            {
              expectToolResults: [
                { name: 'read_skill', includes: 'not eligible for model activation' },
              ],
              text: 'The user-only helper was not loaded.',
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()
    const failed = $('.tool-card[data-tool-id][data-status="error"]')
    await failed.waitForDisplayed({ timeout: 10_000 })
    if (!(await failed.getProperty('open'))) await failed.$('summary.tool-card-header').click()
    await expect(failed).toHaveText('not eligible for model activation', { containing: true })
    await expect(failed).not.toHaveText('MANUAL ONLY BODY', { containing: true })
  })
})
