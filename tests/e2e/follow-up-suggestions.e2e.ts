import { $, $$, browser, expect } from '@wdio/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedEmptyProject,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

async function completeMockTurn(includeDebugCiFollowUp = false) {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  const prompt = 'Review my uncommitted changes and suggest any improvements.'
  const scenario = await installMockScenario({
    title: 'Review uncommitted changes',
    turns: [
      {
        user: prompt,
        responses: [
          {
            text: 'Start by checking the diff summary, then run the relevant tests before merging.',
          },
        ],
      },
      ...(includeDebugCiFollowUp
        ? [
            {
              user: 'The pull request for this branch has failing CI checks. Investigate the failures and fix them.',
              responses: [
                {
                  text: 'Start with the first failing CI job, compare its logs with the changed files, and isolate the earliest failing command.',
                },
              ],
            },
          ]
        : []),
    ],
  })
  await setComposerValue(prompt)
  await $('.submit-btn').click()

  await waitForAgentIdle(20_000)
  await expect($('.msg-assistant .message-text')).toHaveText(
    'Start by checking the diff summary, then run the relevant tests before merging.',
    { containing: true },
  )

  await $('.follow-up-bubble').waitForExist({ timeout: 30_000 })
  return scenario
}

describe('follow-up suggestion bubbles', () => {
  describe('mock demo (Debug CI + Compare models + Continue Plan)', () => {
    let workspace = ''
    before(async () => {
      resetUserData()
      // A dirty development checkout legitimately adds a Changes bubble.
      // Keep the mock-only scenario independent of the branch being tested.
      workspace = mkdtempSync(join(tmpdir(), 'copse-follow-up-demo-'))
      seedEmptyProject(workspace, 'e2e-follow-up-mock-project', {
        subagentsEnabled: false,
        model: 'claude-sonnet-4-6',
        mockFollowUps: true,
      })
      await browser.reloadSession()
    })

    after(() => {
      resetUserData()
      if (workspace) rmSync(workspace, { recursive: true, force: true })
    })

    it('shows demo bubbles after a turn completes', async () => {
      const scenario = await completeMockTurn()
      await expect($$('.follow-up-bubble')).toBeElementsArrayOfSize(4)
      await expect($('.follow-up-bubble-changes')).not.toExist()

      // The accented "publish it" offer sits first, before the prompt chips.
      const createPrBubble = await $('.follow-up-bubble[data-id="create-pr"]')
      await expect(createPrBubble).toHaveText('Create PR')
      await expect(createPrBubble).toHaveElementClass('follow-up-bubble-create-pr')

      const ciBubble = await $('.follow-up-bubble[data-id="debug-ci"]')
      await expect(ciBubble).toHaveText('Debug CI Failure')

      const reviewBubble = await $('.follow-up-bubble[data-id="review-changes"]')
      await expect(reviewBubble).toHaveText('Review changes')

      const continuePlanBubble = await $('.follow-up-bubble[data-id="continue-plan"]')
      await expect(continuePlanBubble).toHaveText('Continue: Run the test suite')

      await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Send follow-up')

      await saveAppScreenshot('follow-up-suggestions-demo.png')
      await scenario.assertComplete()
    })

    it('restores follow-ups when returning to a thread and sends the selected prompt', async function () {
      this.timeout(60_000)
      const scenario = await completeMockTurn(true)
      const originalThreadTitle = await $('.chat-row.selected .chat-title').getText()

      await $('.project-new-thread-btn').click()
      await expect($('.follow-up-suggestions')).not.toBeDisplayed()

      await browser.waitUntil(
        async () =>
          browser.execute((expectedTitle) => {
            const row = [...document.querySelectorAll<HTMLElement>('.chats-list .chat-row')].find(
              (candidate) =>
                !candidate.classList.contains('selected') &&
                candidate.querySelector('.chat-title')?.textContent === expectedTitle,
            )
            if (row) {
              row.click()
              return true
            }
            document.querySelector<HTMLElement>('.chats-show-more')?.click()
            return false
          }, originalThreadTitle),
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: 'expected the completed thread in the sidebar',
        },
      )
      await expect($('.chat-row.selected .chat-title')).toHaveText(originalThreadTitle)
      await $('.follow-up-bubble').waitForDisplayed({ timeout: 10_000 })
      await expect($('.follow-up-bubble[data-id="continue-plan"]')).toHaveText(
        'Continue: Run the test suite',
      )

      await $('.follow-up-bubble[data-id="debug-ci"]').click()
      await expect($('.chat-row.selected .chat-title')).toHaveText(originalThreadTitle)
      await expect($('.messages-list .msg-user')).toBeDisplayed()
      await waitForAgentIdle()
      const assistantMessages = await $$('.messages-list .msg-assistant .message-text')
      const finalReply = assistantMessages.at(-1)
      if (!finalReply) throw new Error('expected the Debug CI follow-up reply')
      await expect(finalReply).toHaveText(
        'Start with the first failing CI job, compare its logs with the changed files, and isolate the earliest failing command.',
        { containing: true },
      )
      await scenario.assertComplete()
    })
  })

  describe('deterministic git changes bubble', () => {
    let repoRoot = ''

    before(async () => {
      resetUserData()
      repoRoot = seedGitChangesFixture()
      await browser.reloadSession()
    })

    after(() => {
      resetUserData()
      if (repoRoot) cleanupGitChangesFixture(repoRoot)
    })

    it('shows a Changes bubble from real git diff stats', async () => {
      const scenario = await completeMockTurn()

      const changesBubble = await $('.follow-up-bubble-changes')
      await expect(changesBubble).toBeDisplayed()
      await expect(changesBubble.$('.follow-up-label')).toHaveText('Changes')

      const addText = await changesBubble.$('.follow-up-stat-add').getText()
      const delText = await changesBubble.$('.follow-up-stat-del').getText()
      await expect(addText.startsWith('+')).toBe(true)
      await expect(delText.startsWith('-')).toBe(true)

      await saveAppScreenshot('follow-up-suggestions-git-changes.png')
      await scenario.assertComplete()
    })
  })
})
