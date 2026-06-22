import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedTodoDisplayFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('todo plan display', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedTodoDisplayFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows inline todo panel and plan tab with statuses', async () => {
    await $('.conversation-todos-host .todo-panel').waitForExist({ timeout: 15_000 })

    const title = (await $('.todo-panel-title').getText()).toLowerCase()
    await expect(title).toBe('to-dos')
    await expect($('.todo-panel-count')).toHaveText('5')
    await expect($('.todo-panel-progress')).toHaveText('1/5 done')

    const inProgress = await $('.todo-item[data-todo-id="todo-2"]')
    await expect(inProgress).toHaveAttribute('data-status', 'in_progress')
    await expect(inProgress.$('.todo-status-icon')).toHaveText('→')

    const completed = await $('.todo-item[data-todo-id="todo-1"]')
    await expect(completed).toHaveAttribute('data-status', 'completed')

    const localBadge = await $('.todo-item[data-todo-id="todo-3"] .todo-badge-local')
    await expect((await localBadge.getText()).toLowerCase()).toBe('local')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'todo-inline-panel.png'))

    const togglePanel = await $('.titlebar-btn[aria-label="Toggle right panel"]')
    await togglePanel.click()

    await $('.right-panel-tab[aria-label="Plan"]').waitForDisplayed({ timeout: 5_000 })
    await $('.right-panel-tab[aria-label="Plan"]').click()
    await browser.waitUntil(async () => (await $$('#plan-viewer-host .todo-item')).length === 5, {
      timeout: 10_000,
      timeoutMsg: 'expected 5 todo items in plan tab',
    })
    await expect($('#plan-viewer-host .todo-panel')).toBeDisplayed()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'todo-plan-tab.png'))
  })
})
