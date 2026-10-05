import { $, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eViewport,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

// Real ask_user tool/IPC coverage: a quick answer only fills a draft. Explicit
// Send in Activity resumes the background agent without changing the open thread.
const PROJECT = 'e2e-activity-answer'
const QUESTION_THREAD = 'e2e-activity-question'
const FOREGROUND_THREAD = 'e2e-activity-foreground'
const PROMPT = 'Choose the migration order.'
const REPLY = 'The migration will add columns first.'
const SEEDED_AT = 1_786_000_000_000

function seededThread(id: string, title: string) {
  return {
    id,
    title,
    status: 'idle',
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        content: 'Review this project.',
        toolCalls: [],
        createdAt: SEEDED_AT,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  }
}

describe('answering a background question from Activity', function () {
  this.timeout(90_000)
  before(async () => {
    resetUserData()
    writeSeedConfig({
      projects: [{ id: PROJECT, path: seedStableWorkspace(), name: 'workspace' }],
      activeProjectId: PROJECT,
      activeThreadId: QUESTION_THREAD,
      [`threads:${PROJECT}`]: [
        seededThread(QUESTION_THREAD, 'Schema bump'),
        seededThread(FOREGROUND_THREAD, 'Other work'),
      ],
    })
    seedE2eViewport(undefined, { model: 'claude-sonnet-4-6', subagentsEnabled: false })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => resetUserData())

  it('fills a rendered quick answer and sends it through the pending question queue', async () => {
    const scenario = await installMockScenario({
      title: 'Schema bump',
      turns: [
        {
          user: PROMPT,
          responses: [
            {
              toolCalls: [
                {
                  name: 'ask_user',
                  args: {
                    questions: [
                      {
                        question: 'Use `columns` first?',
                        options: ['**Columns** first', 'Backfill first'],
                      },
                    ],
                  },
                },
              ],
            },
            { text: REPLY, expectToolResults: [{ name: 'ask_user', includes: 'Columns first' }] },
          ],
        },
      ],
    })
    await setComposerValue(PROMPT)
    await submitComposer()
    await $('#ask-user-dialog').waitForDisplayed({ timeout: 30_000 })
    await $(`.chat-row[data-thread-id="${FOREGROUND_THREAD}"]`).click()
    await $('#ask-user-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
    await $('.projects-activity-btn').click()
    await $('#activity-panel').waitForDisplayed({ timeout: 10_000 })
    const detail = $('#activity-panel .activity-detail')
    await expect(detail.$('.activity-question code')).toHaveText('columns')
    await expect(detail.$('.activity-answer')).toBeDisabled()
    await saveAppScreenshot('activity-answer-panel-waiting.png')
    await detail.$('.activity-option*=Columns').click()
    await expect(detail.$('.activity-answer-input')).toHaveValue('Columns first')
    await expect($('#activity-panel .activity-row[data-state="needs-answer"]')).toExist()
    await detail.$('.activity-answer').waitForEnabled({ timeout: 5_000 })
    await saveAppScreenshot('activity-answer-panel-filled.png')
    await detail.$('.activity-answer').click()
    await expect($('#activity-panel .activity-row[data-state="needs-answer"]')).not.toExist()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', FOREGROUND_THREAD)
    await saveAppScreenshot('activity-answer-panel-sent.png')
    await browser.keys('Escape')
    await $(`.chat-row[data-thread-id="${QUESTION_THREAD}"]`).click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply(REPLY)
    await scenario.assertComplete()
  })
})
