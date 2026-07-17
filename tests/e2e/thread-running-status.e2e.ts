import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedThreadRunningStatusFixture } from './helpers/seed-config.ts'

describe('thread running status dots', () => {
  let runningThreadTitle: string
  let idleThreadTitle: string

  before(async () => {
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

    const placement = await browser.execute(() => {
      const row = document.querySelector('.chat-row.is-running')
      const dots = row?.querySelector('.chat-running-status')
      const title = row?.querySelector('.chat-title')
      if (!row || !dots || !title) return null
      const dotsRect = dots.getBoundingClientRect()
      const titleRect = title.getBoundingClientRect()
      return {
        dotsLeftOfTitle: dotsRect.right <= titleRect.left + 1,
        pathCount: dots.querySelectorAll('path').length,
      }
    })
    await expect(placement).not.toBeNull()
    await expect(placement?.dotsLeftOfTitle).toBe(true)
    await expect(placement?.pathCount).toBe(3)

    const idleHasDots = await browser.execute((title) => {
      const rows = [...document.querySelectorAll('.chats-list .chat-row')]
      const row = rows.find((r) => r.querySelector('.chat-title')?.textContent === title)
      if (!row) return null
      return Boolean(row.querySelector('.chat-running-status'))
    }, idleThreadTitle)
    await expect(idleHasDots).toBe(false)

    await saveElementScreenshot('#pane-projects', 'thread-running-status-dots.png')

    await $('.stop-btn').click()
    await runningRow.waitForExist({ reverse: true, timeout: 10_000 })
  })
})
