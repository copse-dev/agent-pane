import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedThreadRunningStatusFixture } from './helpers/seed-config.ts'

describe('thread running status dots', () => {
  let runningThreadTitle: string
  let idleThreadTitle: string

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    ;({ runningThreadTitle, idleThreadTitle } = seedThreadRunningStatusFixture(process.cwd()))
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows animated dots left of a running thread title', async function () {
    // Live mock turn + screenshot; default 30s mocha timeout is too tight.
    this.timeout(90_000)

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await expect($('.chat-row.selected .chat-title')).toHaveText(runningThreadTitle)

    const seededUnreadRow = await $(`.chat-row*=${idleThreadTitle}`)
    await expect(seededUnreadRow).toHaveElementClass('is-unread')
    await expect(seededUnreadRow.$('.chat-unread-dot')).toHaveAttribute(
      'aria-label',
      'Unread agent completion',
    )
    await saveElementScreenshot('#pane-projects', 'thread-unread-completion-dot.png')

    await seededUnreadRow.click()
    await expect($('.chat-row.selected .chat-title')).toHaveText(idleThreadTitle)
    await seededUnreadRow.$('.chat-unread-dot').waitForExist({ reverse: true, timeout: 5_000 })
    await $(`.chat-row*=${runningThreadTitle}`).click()
    await expect($('.chat-row.selected .chat-title')).toHaveText(runningThreadTitle)

    // Persisted `running` is cleared on load (resumePendingQueues), so drive a
    // live mock turn to put the selected thread into a real running state.
    await setComposerValue('Keep going. [[mock:delay_ms 8000]]')
    await $('.submit-btn').click()

    const runningRow = await $('.chat-row.is-running')
    await runningRow.waitForExist({ timeout: 15_000 })
    await expect(runningRow.$('.chat-title')).toHaveText(runningThreadTitle)
    await expect(runningRow.$('.chat-running-status')).toExist()
    await expect(runningRow.$('.chat-running-status')).toHaveAttribute(
      'aria-label',
      'Agent is working',
    )
    await expect(runningRow.$('.chat-running-status')).toHaveAttribute(
      'data-icon',
      'running-status',
    )

    const placement = await browser.execute((idleTitle) => {
      const rows = [...document.querySelectorAll<HTMLElement>('.chats-list .chat-row')]
      const running = rows.find((r) => r.classList.contains('is-running'))
      const idle = rows.find((r) => r.querySelector('.chat-title')?.textContent === idleTitle)
      const dots = running?.querySelector('.chat-running-status')
      const runningTitle = running?.querySelector('.chat-title')
      const idleTitleEl = idle?.querySelector('.chat-title')
      if (!running || !idle || !dots || !runningTitle || !idleTitleEl) return null
      const dotsRect = dots.getBoundingClientRect()
      const runningTitleRect = runningTitle.getBoundingClientRect()
      const idleTitleRect = idleTitleEl.getBoundingClientRect()
      const rowRect = running.getBoundingClientRect()
      return {
        dotsLeftOfTitle: dotsRect.right <= runningTitleRect.left + 1,
        dotsInGutter: dotsRect.left >= rowRect.left && dotsRect.right <= runningTitleRect.left + 1,
        titlesAligned: Math.abs(runningTitleRect.left - idleTitleRect.left) <= 1,
        idleHasDots: Boolean(idle.querySelector('.chat-running-status')),
        pathCount: dots.querySelectorAll('path').length,
      }
    }, idleThreadTitle)
    await expect(placement).not.toBeNull()
    await expect(placement?.dotsLeftOfTitle).toBe(true)
    await expect(placement?.dotsInGutter).toBe(true)
    await expect(placement?.titlesAligned).toBe(true)
    await expect(placement?.idleHasDots).toBe(false)
    await expect(placement?.pathCount).toBe(3)

    await saveElementScreenshot('#pane-projects', 'thread-running-status-dots.png')

    const idleRow = await $(`.chat-row*=${idleThreadTitle}`)
    await idleRow.click()
    await expect($('.chat-row.selected .chat-title')).toHaveText(idleThreadTitle)

    const unreadRow = await $(`.chat-row*=${runningThreadTitle}`)
    await unreadRow.$('.chat-unread-dot').waitForExist({ timeout: 15_000 })
    await expect(unreadRow).toHaveElementClass('is-unread')
    await expect(unreadRow.$('.chat-unread-dot')).toHaveAttribute(
      'aria-label',
      'Unread agent completion',
    )

    const unreadPlacement = await browser.execute((titleText) => {
      const row = [...document.querySelectorAll<HTMLElement>('.chat-row')].find(
        (candidate) => candidate.querySelector('.chat-title')?.textContent === titleText,
      )
      const title = row?.querySelector<HTMLElement>('.chat-title')
      const dot = row?.querySelector<HTMLElement>('.chat-unread-dot')
      if (!row || !title || !dot) return null
      const rowRect = row.getBoundingClientRect()
      const titleRect = title.getBoundingClientRect()
      const dotRect = dot.getBoundingClientRect()
      return {
        dotLeftOfTitle: dotRect.right <= titleRect.left + 1,
        dotInGutter: dotRect.left >= rowRect.left && dotRect.right <= titleRect.left + 1,
      }
    }, runningThreadTitle)
    await expect(unreadPlacement).not.toBeNull()
    await expect(unreadPlacement?.dotLeftOfTitle).toBe(true)
    await expect(unreadPlacement?.dotInGutter).toBe(true)

    await unreadRow.click()
    await expect($('.chat-row.selected .chat-title')).toHaveText(runningThreadTitle)
    await unreadRow.$('.chat-unread-dot').waitForExist({ reverse: true, timeout: 5_000 })
  })
})
