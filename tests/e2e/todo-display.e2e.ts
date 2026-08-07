import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveThreePaneScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedE2eThreePaneLayout } from './helpers/seed-config.ts'
import { seedTodoPlanFixtures } from './todo-plan-fixtures.ts'

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
  let allCancelledThreadTitle: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    ;({ noPlanThreadTitle, allCancelledThreadTitle } = seedTodoPlanFixtures(process.cwd()))
    seedE2eThreePaneLayout()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows inline todo panel with statuses (rendered as the copse.todos plugin panel)', async () => {
    // P4: the plan panel is now a level-2 declarative plugin contribution from
    // `copse.todos`. The renderer feeds `thread.todos` (still the durable
    // history state, decision 17) into `createPluginPanelEl`, so the DOM shape
    // is the generic `.plugin-panel-list` family — tagged with the plugin ids so
    // the panel is unambiguously the plan panel from the copse.todos plugin.
    const inlinePanel = await $(
      `.conversation-todos-host .plugin-panel[data-plugin-id="copse.todos"][data-contribution-id="plan"]`,
    )
    await inlinePanel.waitForExist({ timeout: 30_000 })

    const title = (await inlinePanel.$('.plugin-panel-title').getText()).toLowerCase()
    await expect(title).toBe('to-dos')
    // The plugin-panel summary carries the same "N/M done" progress the todo
    // panel used to show; count is derived (5 non-cancelled todos in the
    // fixture, 1 completed).
    await expect(inlinePanel.$('.plugin-panel-summary')).toHaveText('1/5 done')

    const inProgress = await inlinePanel.$('.plugin-panel-row[data-row-id="todo-2"]')
    await expect(inProgress).toHaveAttribute('data-status', 'in_progress')
    await expect(inProgress.$('.plugin-panel-status-icon svg[data-icon="arrow-right"]')).toExist()

    const completed = await inlinePanel.$('.plugin-panel-row[data-row-id="todo-1"]')
    await expect(completed).toHaveAttribute('data-status', 'completed')

    const localBadge = await inlinePanel.$(
      '.plugin-panel-row[data-row-id="todo-3"] .plugin-panel-badge[data-badge-kind="assigned-model"]',
    )
    await expect((await localBadge.getText()).toLowerCase()).toBe('local')

    // Cancelled items remain in thread state but are not part of the plan UI.
    await expect(inlinePanel.$('.plugin-panel-row[data-row-id="todo-cancelled"]')).not.toExist()

    await saveAppScreenshot('todo-inline-panel.png')
  })

  it('applies expected padding to the todo panel card', async () => {
    const inlinePanel = await $(
      `.conversation-todos-host .plugin-panel[data-plugin-id="copse.todos"][data-contribution-id="plan"]`,
    )
    await inlinePanel.waitForExist({ timeout: 30_000 })

    const padding = await browser.execute(() => {
      const panel = document.querySelector(
        '.conversation-todos-host .plugin-panel[data-plugin-id="copse.todos"]',
      )
      if (!panel) return null
      const style = getComputedStyle(panel)
      const row = document.querySelector('.plugin-panel-row')
      const rowStyle = row ? getComputedStyle(row) : null
      return {
        panelPaddingTop: style.paddingTop,
        panelPaddingRight: style.paddingRight,
        panelPaddingBottom: style.paddingBottom,
        panelPaddingLeft: style.paddingLeft,
        rowPaddingTop: rowStyle?.paddingTop ?? null,
        rowPaddingBottom: rowStyle?.paddingBottom ?? null,
      }
    })

    expect(padding).not.toBeNull()
    // Match .review-panel / .comparison-panel: --spacing-sm / --spacing-lg (8px / 16px).
    expect(padding!.panelPaddingTop).toBe('8px')
    expect(padding!.panelPaddingBottom).toBe('8px')
    expect(padding!.panelPaddingLeft).toBe('16px')
    expect(padding!.panelPaddingRight).toBe('16px')
    // Rows should have minimal vertical padding (2px) with none horizontally.
    expect(padding!.rowPaddingTop).toBe('2px')
    expect(padding!.rowPaddingBottom).toBe('2px')

    await saveAppScreenshot('todo-inline-panel.png')
  })

  it('hides inline todo panel when every todo is cancelled', async () => {
    await clickThreadByTitle(allCancelledThreadTitle)
    await expect($('.chat-row.selected .chat-title')).toHaveText(allCancelledThreadTitle)
    await browser.waitUntil(
      async () => !(await $('.conversation-todos-host .plugin-panel').isExisting()),
      {
        timeout: 5_000,
        timeoutMsg: 'expected inline todo panel to hide when the plan is all cancelled',
      },
    )

    await saveAppScreenshot('todo-all-cancelled-hidden.png')
  })

  it('hides inline todo panel when the thread has no plan', async () => {
    await clickThreadByTitle(noPlanThreadTitle)
    await expect($('.chat-row.selected .chat-title')).toHaveText(noPlanThreadTitle)
    await browser.waitUntil(
      async () =>
        !(await $(
          `.conversation-todos-host .plugin-panel[data-plugin-id="copse.todos"]`,
        ).isExisting()),
      {
        timeout: 5_000,
        timeoutMsg: 'expected inline todo panel to hide after switching threads',
      },
    )

    await openRightPanel()
    await expect($('.titlebar-btn[aria-label="Toggle right panel"]')).toHaveElementClass('active')
    await expect($('#pane-projects .chats-list')).toBeDisplayed()
    await expect($('#file-tree-host')).toBeDisplayed()

    await saveThreePaneScreenshot('todo-no-plan.png')
  })
})
