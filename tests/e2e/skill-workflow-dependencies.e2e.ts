import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { pinTextForCapture, saveElementScreenshot } from './helpers/screenshot.ts'

// Exercises native invocation, policy, real filesystem reads and transcript rendering.
// Scripted selection proves wiring; it makes no claim about real-model selection quality.
describe('user-invoked workflow dependencies', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(
      seedStableWorkspace({
        files: {
          '.cursor/skills/review-workflow/SKILL.md':
            '---\nname: review-workflow\ndescription: Review project guidance\ndisable-model-invocation: true\ncopse-dependencies: [review-leaf]\n---\nRead review-leaf with read_skill, then its references/checklist.md.',
          '.cursor/skills/review-leaf/SKILL.md':
            '---\nname: review-leaf\ndescription: Review checklist helper\ndisable-model-invocation: true\n---\nCheck the project naming guidance before reviewing.',
          '.cursor/skills/review-leaf/references/checklist.md':
            'Use descriptive names and keep public interfaces small.',
          '.cursor/skills/undeclared-leaf/SKILL.md':
            '---\nname: undeclared-leaf\ndescription: Private helper\ndisable-model-invocation: true\n---\nUNDECLARED INSTRUCTIONS',
        },
      }),
      'skill-workflow-project',
      { model: 'claude-sonnet-4-6', subagentsEnabled: false },
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('loads only the declared leaf and supporting file, and attributes its authority visibly', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('/review-workflow')
    await $('.skill-picker')
      .$('.skill-item*=/review-workflow')
      .waitForDisplayed({ timeout: 10_000 })
    const prompt = 'Review the project guidance.'
    const scenario = await installMockScenario({
      title: 'Declared workflow dependency',
      turns: [
        {
          user: prompt,
          responses: [
            { toolCalls: [{ name: 'read_skill', args: { name: 'review-leaf' } }] },
            {
              expectToolResults: [
                {
                  name: 'read_skill',
                  includes:
                    'Workflow dependency activated: review-leaf (declared by review-workflow)',
                },
              ],
              toolCalls: [
                {
                  name: 'read_skill',
                  args: { name: 'review-leaf', path: 'references/checklist.md' },
                },
              ],
            },
            {
              expectToolResults: [
                {
                  name: 'read_skill',
                  includes: 'Use descriptive names and keep public interfaces small.',
                },
              ],
              toolCalls: [{ name: 'read_skill', args: { name: 'undeclared-leaf' } }],
            },
            {
              expectToolResults: [
                { name: 'read_skill', includes: 'not eligible for model activation' },
              ],
              text: 'The checklist calls for descriptive names and small public interfaces.',
            },
          ],
        },
      ],
    })
    await setComposerValue(`/review-workflow ${prompt}`)
    await submitComposer()
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()
    const rollup = $('.tool-card-rollup')
    await rollup.waitForDisplayed({ timeout: 10_000 })
    if (!(await rollup.getProperty('open'))) await rollup.$('summary.tool-card-header').click()
    const cards = await $$('.tool-card[data-tool-id]').getElements()
    const first = cards[0]
    if (!first) throw new Error('No dependency card rendered')
    if (!(await first.getProperty('open'))) await first.$('summary.tool-card-header').click()
    await expect(first).toHaveText(
      'Workflow dependency activated: review-leaf (declared by review-workflow)',
      { containing: true },
    )
    await expect(first).toHaveText('UNTRUSTED SOURCE', { containing: true })
    await expect(first).toHaveText('Context estimate: approximately', { containing: true })
    await expect(first).not.toHaveText('UNDECLARED INSTRUCTIONS', { containing: true })
    const failed = $('.tool-card[data-tool-id][data-status="error"]')
    await expect(failed).toExist()
    if (!(await failed.getProperty('open'))) await failed.$('summary.tool-card-header').click()
    await expect(failed).toHaveText('not eligible for model activation', { containing: true })
    await expect(failed).not.toHaveText('UNDECLARED INSTRUCTIONS', { containing: true })
    await failed.$('summary.tool-card-header').click()
    const id = await first.getAttribute('data-tool-id')
    if (!id) throw new Error('Dependency card has no id')
    const selector = `.tool-card[data-tool-id="${id}"]`
    // The native reader reports the host temp prefix, which differs across CI and macOS.
    // Preserve the real DOM assertions above and mask only that prefix for capture.
    const restore = await pinTextForCapture(
      selector,
      /\/(?:[^/\s]+\/)*copse-e2e\/workspace/g,
      '<workspace>',
    )
    try {
      await saveElementScreenshot(selector, 'skill-workflow-dependency.png')
    } finally {
      await restore()
    }
  })
})
