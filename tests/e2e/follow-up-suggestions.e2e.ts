import { $, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedEmptyProject,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

async function completeMockTurn(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await setComposerValue('review my changes')
  await $('.submit-btn').click()

  await waitForAgentIdle(20_000)

  await $('.follow-up-bubble').waitForExist({ timeout: 30_000 })
}

describe('follow-up suggestion bubbles', () => {
  describe('mock demo (Changes + Debug CI + Continue Plan)', () => {
    before(async () => {
      resetUserData()
      seedEmptyProject(process.cwd(), 'e2e-follow-up-mock-project', {
        subagentsEnabled: false,
        model: 'claude-sonnet-4-6',
        mockFollowUps: true,
      })
      await browser.reloadSession()
    })

    after(() => {
      resetUserData()
    })

    it('shows demo bubbles after a turn completes', async () => {
      await completeMockTurn()

      const changesBubble = await $('.follow-up-bubble-changes')
      await expect(changesBubble).toBeDisplayed()
      await expect(changesBubble.$('.follow-up-stat-add')).toHaveText('+1')
      await expect(changesBubble.$('.follow-up-stat-del')).toHaveText('-1')

      const ciBubble = await $('.follow-up-bubble[data-id="debug-ci"]')
      await expect(ciBubble).toHaveText('Debug CI Failure')

      const continuePlanBubble = await $('.follow-up-bubble[data-id="continue-plan"]')
      await expect(continuePlanBubble).toHaveText('Continue: Run the test suite')

      await expect($('.prompt-input')).toHaveAttribute('data-placeholder', 'Send follow-up')

      await saveAppScreenshot('follow-up-suggestions-demo.png')
    })

    it('restores follow-ups when returning to a completed thread', async () => {
      await completeMockTurn()

      await $('.project-new-thread-btn').click()
      await expect($('.follow-up-suggestions')).not.toBeDisplayed()

      const showMore = await $('.chats-show-more')
      if (await showMore.isExisting()) await showMore.click()

      await browser.execute(() => {
        const rows = [...document.querySelectorAll('.chats-list .chat-row')]
        const previous = rows.find((row) => !row.classList.contains('selected'))
        previous?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await $('.follow-up-bubble').waitForDisplayed({ timeout: 10_000 })
      await expect($('.follow-up-bubble[data-id="continue-plan"]')).toHaveText(
        'Continue: Run the test suite',
      )
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
      await completeMockTurn()

      const changesBubble = await $('.follow-up-bubble-changes')
      await expect(changesBubble).toBeDisplayed()
      await expect(changesBubble.$('.follow-up-label')).toHaveText('Changes')

      const addText = await changesBubble.$('.follow-up-stat-add').getText()
      const delText = await changesBubble.$('.follow-up-stat-del').getText()
      await expect(addText.startsWith('+')).toBe(true)
      await expect(delText.startsWith('-')).toBe(true)

      await saveAppScreenshot('follow-up-suggestions-git-changes.png')
    })
  })
})
