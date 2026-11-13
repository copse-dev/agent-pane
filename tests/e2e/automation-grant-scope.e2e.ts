import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { $, browser, expect } from '@wdio/globals'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

const PROJECT_ID = 'e2e-automation-grant-scope'
const THREAD_ID = 'completed-automation-run'
const SCHEDULE_ID = 'schedule-review'
const SCHEDULE_PROMPT = 'Review pull requests.'
const MODEL = 'claude-sonnet-4-6'
const LATER_PROMPT = 'Approve pull request 1478.'

describe('automation grant scope', () => {
  before(async () => {
    resetUserData()
    const root = seedStableWorkspace()
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], {
      cwd: root,
      stdio: 'pipe',
    })
    seedEmptyProject(root, PROJECT_ID, { model: MODEL, subagentsEnabled: false })
    const triggeredAt = 1_786_000_000_000
    const digest = createHash('sha256')
      .update(JSON.stringify([SCHEDULE_PROMPT, MODEL]))
      .digest('hex')
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: root, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Pull request review',
          status: 'idle',
          messages: [
            {
              id: 'scheduled-prompt',
              role: 'user',
              content: SCHEDULE_PROMPT,
              toolCalls: [],
              createdAt: triggeredAt,
            },
            {
              id: 'scheduled-answer',
              role: 'assistant',
              content: 'The review is complete.',
              toolCalls: [],
              createdAt: triggeredAt + 1,
            },
          ],
          usage: { inputTokens: 20, outputTokens: 8 },
          model: MODEL,
          automation: {
            scheduleId: SCHEDULE_ID,
            scheduleName: 'Pull request review',
            triggeredAt,
          },
          createdAt: triggeredAt,
          updatedAt: triggeredAt + 1,
        },
      ],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE_ID,
                projectId: PROJECT_ID,
                name: 'Pull request review',
                cron: '0 9 * * 1-5',
                prompt: SCHEDULE_PROMPT,
                model: MODEL,
                enabled: false,
                permissions: [{ kind: 'copse-action', toolName: 'gh_pr_approve' }],
                lastRunAt: triggeredAt,
                lastCreatedThreadId: THREAD_ID,
                lastRunPromptDigest: digest,
                lastRunGrantClaimed: true,
                createdAt: triggeredAt - 1,
                updatedAt: triggeredAt + 1,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('prompts before a later chat turn uses a scheduled GitHub grant', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await prepareMockToolTurn(
      LATER_PROMPT,
      { name: 'gh_pr_approve', args: { number: 1478 } },
      'The approval was declined.',
    )
    await submitComposer()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Approve pull request on GitHub?')
    await expect(dialog.$('.approval-body')).toHaveText('PR #1478')
    await expect(dialog.$('.approval-approve')).toBeDisplayed()
    await expect(dialog.$('.approval-reject')).toBeDisplayed()
    await saveElementScreenshot('#approval-dialog', 'automation-later-turn-approval.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle()
  })
})
