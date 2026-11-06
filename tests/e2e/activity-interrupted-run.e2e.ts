import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import type { Thread } from '../../src/shared/types/index.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { composerText } from './helpers/composer.ts'
import {
  resetUserData,
  seedE2eViewport,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'

const PROJECT = 'e2e-interrupted-activity'
const INTERRUPTED = 'e2e-interrupted-run'
const FINISHED = 'e2e-finished-run'
const AT = Date.now() - 62 * 60_000
const SAVED = 'The first checkpoint is saved. The remaining migration is unfinished.'

function savedThread(id: string, title: string, response: string): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        content: 'Check the project.',
        toolCalls: [],
        createdAt: AT - 1,
      },
      { id: `${id}-reply`, role: 'assistant', content: response, toolCalls: [], createdAt: AT },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
    lastPromptAt: AT - 1,
    lastSettledAt: AT,
    createdAt: AT - 1,
    updatedAt: AT,
  }
}

async function openActivity(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await $('.prompt-input').click()
  await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'a'])
  await $('#activity-panel').waitForDisplayed({ timeout: 10_000 })
}

async function expectInterruption(): Promise<void> {
  const row = $(`#activity-panel .activity-row[data-thread-id="${INTERRUPTED}"]`)
  await row.waitForDisplayed({ timeout: 10_000 })
  await expect(row).toHaveAttribute('data-state', 'failed')
  await expect(row.$('.activity-state')).toHaveText('Failed')
  await expect(row.$('.activity-issue')).toHaveText('Run interrupted')
  await row.$('.activity-row-open').click()
  const detail = $('#activity-panel .activity-detail')
  await expect(detail.$('.activity-issue-title')).toHaveText('Run interrupted')
  await expect(detail.$('.activity-issue-remedy')).toHaveText(
    'Open the conversation to review saved work and continue when ready.',
  )
  await expect(detail.$('.activity-final-reply')).not.toBeExisting()
  await expect(detail.$('.activity-open-thread')).toBeEnabled()
  await expect(
    $(`#activity-panel .activity-row[data-thread-id="${FINISHED}"] .activity-state`),
  ).toHaveText('Done')
}

describe('Interrupted automation in Activity', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    const workspace = seedStableWorkspace()
    writeSeedConfig({
      projects: [{ id: PROJECT, path: workspace, name: 'workspace' }],
      activeProjectId: PROJECT,
      activeThreadId: FINISHED,
      [`threads:${PROJECT}`]: [
        {
          ...savedThread(INTERRUPTED, 'Interrupted project check', SAVED),
          interruptedTurnAt: AT,
          currentEpoch: 'saved-human-turn',
          continuationUsed: 5,
          automation: {
            scheduleId: 'e2e-nightly-check',
            scheduleName: 'Nightly project check',
            triggeredAt: AT - 1,
          },
        },
        savedThread(FINISHED, 'Completed project check', 'All requested checks completed.'),
      ],
    })
    seedE2eViewport()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('keeps the interruption discoverable after reload and opens saved work without retrying', async () => {
    await openActivity()
    await expectInterruption()
    await browser.reloadSession()
    await openActivity()
    await expectInterruption()
    const fits = await browser.execute(() => {
      const pane = document.querySelector<HTMLElement>('#activity-panel .activity-detail')
      const action = document.querySelector<HTMLButtonElement>(
        '#activity-panel .activity-open-thread',
      )
      if (!pane || !action) return null
      const p = pane.getBoundingClientRect()
      const a = action.getBoundingClientRect()
      return {
        noSideScroll: pane.scrollWidth <= pane.clientWidth,
        actionInside:
          a.left >= p.left && a.right <= p.right && a.top >= p.top && a.bottom <= p.bottom,
      }
    })
    assert.deepEqual(fits, { noSideScroll: true, actionInside: true })
    await $('#activity-panel-title').moveTo()
    await saveAppScreenshot('activity-interrupted-run.png')
    await $('#activity-panel .activity-open-thread').click()
    await $('#activity-panel').waitForDisplayed({ reverse: true, timeout: 10_000 })
    await expect($(`.chat-row[data-thread-id="${INTERRUPTED}"].selected`)).toBeExisting()
    await expect($(`[data-message-id="${INTERRUPTED}-reply"] .message-text`)).toHaveText(SAVED)
    assert.equal(await composerText(), '')
  })
})
