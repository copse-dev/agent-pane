import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { installMockScenario, expectAssistantReply } from './helpers/mock-scenario.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('generic subagent invocation', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(
      seedStableWorkspace({ files: { 'selected.txt': 'SELECTED-CONTEXT' } }),
      'run-agent-project',
      {
        model: 'claude-sonnet-4-6',
        subagentsEnabled: false,
        roleModels: { planner: 'claude-sonnet-4-6' },
      },
    )
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('delegates through the native tool, uses the configured role, and displays the child report', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const child = await installMockScenario(
      {
        title: 'Selected context child',
        turns: [
          {
            user: { includes: 'Task:\nPlan the supplied change' },
            responses: [{ text: 'Plan: inspect the supplied context, implement, then verify.' }],
          },
        ],
      },
      null,
    )
    const prompt = 'Delegate a plan using only the context I supply.'
    const parent = await installMockScenario({
      title: 'Generic delegation parent',
      turns: [
        {
          user: prompt,
          responses: [
            {
              toolCalls: [
                {
                  name: 'run_agent',
                  args: {
                    task: 'Plan the supplied change',
                    context: 'Change the greeting.',
                    tools: [],
                    task_type: 'planner',
                    intelligence: 'mid',
                  },
                },
              ],
            },
            {
              expectToolResults: [{ name: 'run_agent', includes: '"source":"settings"' }],
              text: 'The planning subagent completed its report.',
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle(60_000)
    await parent.assertComplete()
    await child.assertComplete()
    await expectAssistantReply('The planning subagent completed its report.')
    const card = $('.tool-card-subagent')
    await card.waitForExist({ timeout: 10_000 })
    if (!(await card.getProperty('open'))) await card.$('summary.tool-card-header').click()
    await expect(card.$('.subagent-model')).toHaveText('Claude Sonnet 4.6')
    await expect(card).toHaveText('Plan: inspect the supplied context, implement, then verify.', {
      containing: true,
    })
    await expect(card.$('.subagent-task')).toHaveText('Plan the supplied change')
    await expect(card.$('.subagent-parent-result')).not.toExist()
    await expect(card.$('.subagent-routing-warning')).toHaveText(
      'The configured model is in the low band, below the requested mid band; the Settings assignment takes precedence.',
    )
    const technical = card.$('.subagent-technical-details')
    await expect(technical).not.toHaveAttribute('open')
    await expect(technical.$('pre')).not.toBeDisplayed()
    await saveElementScreenshot('.tool-card-subagent', 'run-agent-configured-role.png')
    await technical.$('summary').click()
    await expect(technical.$('pre')).toBeDisplayed()
    await expect(technical.$('pre')).toHaveText('"workerId":', { containing: true })
  })
})
