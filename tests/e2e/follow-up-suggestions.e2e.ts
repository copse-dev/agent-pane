import { $, $$, browser, expect } from '@wdio/globals'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedEmptyProject,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { completeMockTurn } from './helpers/follow-up-suggestions.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { e2eGitBranch } from './helpers/e2e-env.ts'
import { expectAssistantReply } from './helpers/mock-scenario.ts'

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
      if (workspace) removeE2eTree(workspace)
    })

    it('shows demo bubbles after a turn completes', async () => {
      const scenario = await completeMockTurn()
      await expect($$('.follow-up-bubble')).toBeElementsArrayOfSize(4)
      await expect($('.follow-up-bubble-changes')).not.toExist()

      // The accented "publish it" offer sits first, before the prompt chips.
      const createPrBubble = await $('.follow-up-bubble[data-id="create-pr"]').getElement()
      await expect(createPrBubble).toHaveText('Create PR')
      await expect(createPrBubble).toHaveElementClass('follow-up-bubble-create-pr')

      const ciBubble = await $('.follow-up-bubble[data-id="debug-ci"]').getElement()
      await expect(ciBubble).toHaveText('Debug CI Failure')

      const reviewBubble = await $('.follow-up-bubble[data-id="review-changes"]').getElement()
      await expect(reviewBubble).toHaveText('Review changes')

      const continuePlanBubble = await $('.follow-up-bubble[data-id="continue-plan"]').getElement()
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
      // Idle can arrive before the new reply mounts. Re-read the last reply
      // while waiting instead of retaining the preceding turn's DOM element.
      await expectAssistantReply(
        'Start with the first failing CI job, compare its logs with the changed files, and isolate the earliest failing command.',
      )
      await scenario.assertComplete()
    })
  })

  describe('deterministic git changes bubble', () => {
    let repoRoot = ''

    before(async () => {
      resetUserData()
      repoRoot = seedGitChangesFixture()
      // The app reports this fixed branch under e2e. Give it a real ref at
      // the committed fixture HEAD so first-send checkout selection does not
      // fall back to main and lose the committed addition from the total.
      execFileSync('git', ['branch', '-f', e2eGitBranch(), 'HEAD'], { cwd: repoRoot })
      await browser.reloadSession()
    })

    after(() => {
      resetUserData()
      if (repoRoot) {
        cleanupGitChangesFixture(repoRoot)
        execFileSync('git', ['branch', '-D', e2eGitBranch()], { cwd: repoRoot })
      }
    })

    it('shows a Changes bubble from real git diff stats', async () => {
      // Blank threads default to main. Stay on the fixture's branch so the
      // committed addition remains part of the Changes review scope.
      await $('.branch-picker-trigger').click()
      await $(`.branch-picker-option-label=${e2eGitBranch()}`).click()
      // The Changes bubble needs the dirty shared checkout itself, so send on
      // top of it rather than moving to a clean isolated worktree.
      const scenario = await completeMockTurn(false, { dirtySharedCheckout: true })

      const changesBubble = await $('.follow-up-bubble-changes').getElement()
      await expect(changesBubble).toBeDisplayed()
      await expect(changesBubble.$('.follow-up-label')).toHaveText('Changes')

      await expect(changesBubble.$('.follow-up-stat-add')).toHaveText('+4')
      await expect(changesBubble.$('.follow-up-stat-del')).toHaveText('-2')

      await saveAppScreenshot('follow-up-suggestions-git-changes.png')
      await scenario.assertComplete()
    })
  })
})
