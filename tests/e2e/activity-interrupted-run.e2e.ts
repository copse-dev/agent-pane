import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import type { Thread } from '../../src/shared/types/index.ts'
import { parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { composerText, setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { acceptanceWakeTurn, readTranscriptNotices } from './helpers/acceptance-wake.ts'
import { waitForActiveThreadTitle, waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
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
    removeE2eTree(join(e2eWorkspaceDir(), PROJECT))
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

describe('Activity after an admitted machine continuation', function () {
  this.timeout(90_000)
  const project = 'e2e-activity-machine-continuation'
  const path = 'accepted-check.txt'
  const content = 'The accepted update is ready.\n'
  const proposed = 'The project update is ready for acceptance.'
  const completed = 'The accepted project update has been verified.'
  let workspace = ''

  before(async () => {
    resetUserData()
    // A non-git workspace uses the real proposed-change and acceptance path.
    workspace = mkdtempSync(join(tmpdir(), 'copse-activity-continuation-'))
    seedEmptyProject(workspace, project, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    seedE2eViewport()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    removeE2eTree(join(e2eWorkspaceDir(), project))
    if (workspace) removeE2eTree(workspace)
  })

  it('replaces the interruption with the actual accepted-change result, including after restart', async () => {
    const scenario = await installMockScenario({
      title: 'Accepted project update',
      turns: [
        {
          user: 'Prepare the project update for acceptance.',
          responses: [
            { toolCalls: [{ name: 'write_file', args: { path, content } }] },
            { text: proposed, expectToolResults: [{ name: 'write_file' }] },
          ],
        },
        acceptanceWakeTurn([path], completed),
      ],
    })
    await setComposerValue('Prepare the project update for acceptance.')
    await $('.submit-btn').click()
    await expectAssistantReply(proposed)
    await waitForAgentIdle(30_000)
    await waitForActiveThreadTitle()
    await scenario.waitForTurns(1)
    const id = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(id)

    // Inject the existing recovery metadata at its real persistence boundary.
    // The proposal/epoch remains in main through a renderer reload; this does
    // not claim that in-memory proposals survive a whole-app restart.
    const before = await browser.execute(
      async ({ projectId, threadId }) => {
        await window.api.threads.updateMeta(projectId, threadId, {
          status: 'idle',
          interruptedTurnAt: Date.now(),
        })
        const saved = (await window.api.threads.loadProject(projectId)).find(
          (thread) => thread.id === threadId,
        )
        return saved ? { epoch: saved.currentEpoch, budget: saved.continuationUsed } : null
      },
      { projectId: project, threadId: id },
    )
    assert.ok(before?.epoch)
    await browser.execute(() => {
      window.location.reload()
    })
    await openActivity()
    let row = $(`#activity-panel .activity-row[data-thread-id="${id}"]`)
    await expect(row).toHaveAttribute('data-state', 'failed')
    await expect(row.$('.activity-issue')).toHaveText('Run interrupted')
    await $('.activity-panel-close').click()

    if (!(await $('#git-changes-host').isDisplayed())) {
      await $('.titlebar-btn[aria-label="Open changes"]').click()
    }
    const accept = $('#git-diff-viewer-host .diff-accept-btn')
    await accept.waitForDisplayed({ timeout: 15_000 })
    const notices = await readTranscriptNotices()
    await accept.click()
    await expectAssistantReply(completed)
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await waitForAgentIdle(30_000)
    assert.equal(readFileSync(join(workspace, path), 'utf8'), content)
    assert.deepEqual((await readTranscriptNotices()).prompts, notices.prompts)
    const after = await browser.execute(
      async ({ projectId, threadId }) => {
        const saved = (await window.api.threads.loadProject(projectId)).find(
          (thread) => thread.id === threadId,
        )
        return saved
          ? {
              epoch: saved.currentEpoch,
              budget: saved.continuationUsed,
              interrupted: saved.interruptedTurnAt !== undefined,
              status: saved.status,
            }
          : null
      },
      { projectId: project, threadId: id },
    )
    assert.ok(after)
    assert.equal(after.epoch, before.epoch)
    assert.equal(after.budget, (before.budget ?? 0) + 1)
    assert.equal(after.interrupted, false)
    assert.equal(after.status, 'idle')

    // Main is now restarted too: the finished state must come from disk.
    await browser.reloadSession()
    await openActivity()
    row = $(`#activity-panel .activity-row[data-thread-id="${id}"]`)
    await expect(row).toHaveAttribute('data-state', 'finished')
    await expect(row.$('.activity-state')).toHaveText('Done')
    await expect(row.$('.activity-issue')).not.toBeExisting()
    await row.$('.activity-row-open').click()
    const detail = $('#activity-panel .activity-detail')
    await expect(detail.$('.activity-final-reply')).toHaveText(expect.stringContaining(completed))
    await expect(detail.$('.activity-issue-title')).not.toBeExisting()
    await expect(detail.$('.activity-open-thread')).toBeEnabled()
    await parkPointer()
    await saveAppScreenshot('activity-machine-continuation-finished.png')
  })

  it('keeps an ordinary human retry finished after a marked disk seed and restart', async () => {
    if (await $('#activity-panel').isDisplayed()) await $('.activity-panel-close').click()
    const id = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(id)
    await browser.execute(
      async ({ projectId, threadId }) => {
        await window.api.threads.updateMeta(projectId, threadId, {
          status: 'idle',
          interruptedTurnAt: Date.now(),
        })
        window.location.reload()
      },
      { projectId: project, threadId: id },
    )
    await openActivity()
    const interrupted = $(`#activity-panel .activity-row[data-thread-id="${id}"]`)
    await expect(interrupted.$('.activity-issue')).toHaveText('Run interrupted')
    await $('.activity-panel-close').click()
    const reply = 'The fresh human request is complete.'
    const prompt = 'Continue with the fresh human request.'
    const scenario = await installMockScenario({
      title: 'Fresh human retry',
      turns: [{ user: prompt, responses: [{ text: reply }] }],
    })
    await setComposerValue(prompt)
    await $('.submit-btn').click()
    await expectAssistantReply(reply)
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await waitForAgentIdle(30_000)
    const saved = await browser.execute(
      async ({ projectId, threadId }) => {
        const thread = (await window.api.threads.loadProject(projectId)).find(
          (entry) => entry.id === threadId,
        )
        return thread
          ? { interrupted: thread.interruptedTurnAt !== undefined, status: thread.status }
          : null
      },
      { projectId: project, threadId: id },
    )
    assert.ok(saved)
    assert.equal(saved.interrupted, false)
    assert.equal(saved.status, 'idle')
    await browser.reloadSession()
    await openActivity()
    const row = $(`#activity-panel .activity-row[data-thread-id="${id}"]`)
    await expect(row).toHaveAttribute('data-state', 'finished')
    await expect(row.$('.activity-state')).toHaveText('Done')
    await expect(row.$('.activity-issue')).not.toBeExisting()
    await row.$('.activity-row-open').click()
    await expect($('#activity-panel .activity-final-reply')).toHaveText(
      expect.stringContaining(reply),
    )
    await expect($('#activity-panel .activity-issue-title')).not.toBeExisting()
    await parkPointer()
    await saveAppScreenshot('activity-human-retry-finished.png')
  })
})
