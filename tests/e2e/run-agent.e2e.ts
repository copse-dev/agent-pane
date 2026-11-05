import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'
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

  it('keeps routing and disclosure visible when the stored report has a host reminder', async () => {
    resetUserData()
    const root = seedStableWorkspace()
    const projectId = 'run-agent-reminder-project'
    const threadId = 'run-agent-reminder-thread'
    const report = 'Inspect the supplied context, implement, then verify.'
    const reminder = '<system-reminder>\nKeep changes within this task.\n</system-reminder>'
    const raw = JSON.stringify({
      workerId: 'worker-reminder',
      report,
      routing: { warning: 'The Settings assignment takes precedence.' },
    })
    const now = Date.UTC(2026, 10, 1, 12)
    seedEmptyProject(root, projectId, { model: 'claude-sonnet-4-6' })
    writeSeedConfig({
      projects: [{ id: projectId, name: 'workspace', path: root }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Delegated plan',
          status: 'idle',
          model: 'claude-sonnet-4-6',
          createdAt: now,
          updatedAt: now + 1,
          usage: { inputTokens: 0, outputTokens: 0 },
          messages: [
            {
              id: 'reminder-message',
              role: 'assistant',
              content: 'The planning subagent completed its report.',
              createdAt: now,
              toolCalls: [
                {
                  id: 'reminder-call',
                  name: 'run_agent',
                  args: { task: 'Plan the supplied change' },
                  status: 'done',
                  result: `${raw}\n\n${reminder}`,
                  appendedReminderLengths: [reminder.length],
                  subagent: {
                    id: 'reminder-child',
                    kind: 'custom',
                    status: 'done',
                    prompt: 'Plan the supplied change',
                    summary: report,
                    model: 'claude-sonnet-4-6',
                    messages: [{ id: 'child-message', role: 'assistant', content: report }],
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    await browser.reloadSession()
    const card = $('.tool-card-subagent')
    await card.waitForExist({ timeout: 30_000 })
    if (!(await card.getProperty('open'))) await card.$('summary.tool-card-header').click()
    await expect(card.$('.subagent-parent-result')).not.toExist()
    await expect(card.$('.subagent-routing-warning')).toHaveText(
      'The Settings assignment takes precedence.',
    )
    await expect(card.$('.tool-result-note')).toHaveText('Keep changes within this task.')
    const technical = card.$('.subagent-technical-details')
    await expect(technical).not.toHaveAttribute('open')
    await expect(technical.$('pre')).not.toBeDisplayed()
    await saveElementScreenshot('.tool-card-subagent', 'run-agent-appended-reminder.png')
    await technical.$('summary').click()
    await expect(technical.$('pre')).toBeDisplayed()
    await expect(technical.$('pre')).toHaveText(raw)
  })
})
