import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveThreePaneScreenshot,
} from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedTodoPlanFixtures,
} from './helpers/seed-config.ts'

async function openRightPanel(): Promise<void> {
  const pane = await $('#pane-files')
  if (await pane.isDisplayed()) return
  await (await $('.titlebar-btn[aria-label="Toggle right panel"]')).click()
  await pane.waitForDisplayed({ timeout: 5_000 })
}

async function clickThreadByTitle(title: string): Promise<void> {
  await browser.execute((threadTitle) => {
    const rows = [...document.querySelectorAll('.chats-list .chat-row')]
    const row = rows.find((r) => r.querySelector('.chat-title')?.textContent === threadTitle)
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, title)
}

describe('todo plan display', () => {
  let noPlanThreadTitle: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    ;({ noPlanThreadTitle } = seedTodoPlanFixtures(process.cwd()))
    seedE2eThreePaneLayout()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows inline todo panel and plan tab with statuses', async () => {
    const inlinePanel = await $('.conversation-todos-host .todo-panel')
    await inlinePanel.waitForExist({ timeout: 15_000 })

    const title = (await inlinePanel.$('.todo-panel-title').getText()).toLowerCase()
    await expect(title).toBe('to-dos')
    await expect(inlinePanel.$('.todo-panel-count')).toHaveText('5')
    await expect(inlinePanel.$('.todo-panel-progress')).toHaveText('1/5 done')

    const inProgress = await inlinePanel.$('.todo-item[data-todo-id="todo-2"]')
    await expect(inProgress).toHaveAttribute('data-status', 'in_progress')
    await expect(inProgress.$('.todo-status-icon')).toHaveText('→')

    const completed = await inlinePanel.$('.todo-item[data-todo-id="todo-1"]')
    await expect(completed).toHaveAttribute('data-status', 'completed')

    const localBadge = await inlinePanel.$('.todo-item[data-todo-id="todo-3"] .todo-badge-local')
    await expect((await localBadge.getText()).toLowerCase()).toBe('local')

    await saveAppScreenshot('todo-inline-panel.png')

    await openRightPanel()

    await $('.right-panel-tab[aria-label="Plan"]').waitForDisplayed({ timeout: 5_000 })
    await (await $('.right-panel-tab[aria-label="Plan"]')).click()
    await browser.waitUntil(async () => (await $$('#plan-viewer-host .todo-item')).length === 5, {
      timeout: 10_000,
      timeoutMsg: 'expected 5 todo items in plan tab',
    })
    await expect($('#plan-viewer-host .todo-panel')).toBeDisplayed()

    await saveAppScreenshot('todo-plan-tab.png')
  })

  it('hides inline todo panel and Plan tab when the thread has no plan', async () => {
    await clickThreadByTitle(noPlanThreadTitle)
    await expect($('.chat-row.selected .chat-title')).toHaveText(noPlanThreadTitle)
    await browser.waitUntil(
      async () => !(await $('.conversation-todos-host .todo-panel').isExisting()),
      {
        timeout: 5_000,
        timeoutMsg: 'expected inline todo panel to hide after switching threads',
      },
    )

    await openRightPanel()
    await (await $('.right-panel-tab[aria-label="Explorer"]')).click()
    await expect($('.right-panel-tab[aria-label="Explorer"]')).toHaveElementClass('is-active')
    await expect($('.right-panel-tab[aria-label="Plan"]')).not.toBeDisplayed()
    await expect($('#pane-projects .chats-list')).toBeDisplayed()
    await expect($('#file-tree-host')).toBeDisplayed()
    await expect($('#plan-viewer-host')).not.toBeDisplayed()

    await saveThreePaneScreenshot('todo-no-plan.png')
  })
})
