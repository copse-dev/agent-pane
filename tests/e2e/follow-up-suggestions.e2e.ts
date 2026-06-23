import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedEmptyProject,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function completeMockTurn(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await $('.prompt-input').setValue('review my changes')
  await $('.submit-btn').click()

  await waitForAgentIdle(20_000)

  await $('.follow-up-bubble').waitForExist({ timeout: 15_000 })
}

describe('follow-up suggestion bubbles', () => {
  describe('mock demo (Changes + Debug CI)', () => {
    before(async () => {
      mkdirSync(SCREENSHOT_DIR, { recursive: true })
      resetUserData()
      seedEmptyProject(process.cwd(), 'e2e-follow-up-mock-project', {
        subagentsEnabled: false,
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

      await expect($('.prompt-input')).toHaveAttribute('placeholder', 'Send follow-up')

      await browser.saveScreenshot(join(SCREENSHOT_DIR, 'follow-up-suggestions-demo.png'))
    })

    it('restores follow-ups when returning to a thread and reopens it on prompt click', async () => {
      await completeMockTurn()

      const originalThreadTitle = await $('.chat-row.selected .chat-title').getText()
      await $('.project-new-thread-btn').click()
      await expect($('.follow-up-suggestions')).not.toBeDisplayed()

      await browser.execute(() => {
        const rows = [...document.querySelectorAll('.chats-list .chat-row')]
        const previous = rows.find((row) => !row.classList.contains('selected'))
        previous?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await $('.follow-up-bubble').waitForDisplayed({ timeout: 10_000 })

      await $('.project-new-thread-btn').click()
      await browser.execute(() => {
        const el = document.querySelector('.follow-up-suggestions')
        if (el instanceof HTMLElement) el.hidden = false
      })

      await $('.follow-up-bubble[data-id="debug-ci"]').click()
      await expect($('.chat-row.selected .chat-title')).toHaveText(originalThreadTitle)
      await expect($('.messages-list .msg-user')).toBeDisplayed()
    })
  })

  describe('deterministic git changes bubble', () => {
    let repoRoot = ''

    before(async () => {
      mkdirSync(SCREENSHOT_DIR, { recursive: true })
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

      await browser.saveScreenshot(join(SCREENSHOT_DIR, 'follow-up-suggestions-git-changes.png'))
    })
  })
})
