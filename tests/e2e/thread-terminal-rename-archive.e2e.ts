import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import {
  resetUserData,
  seedStableWorkspace,
  seedThreadRenameArchiveFixture,
} from './helpers/seed-config.ts'

describe('thread + terminal rename / archive', () => {
  let keepTitle: string
  let archiveTitle: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    ;({ keepTitle, archiveTitle } = seedThreadRenameArchiveFixture(seedStableWorkspace()))
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('thread dots and right-click share actions; double-click renames and Archive hides the row', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const archiveRow = await $(`.chat-row*=${archiveTitle}`).getElement()
    await archiveRow.waitForExist({ timeout: 10_000 })

    // The dots open the menu without selecting or deleting this thread.
    const selectedThreadId = await $('.chat-row.selected').getAttribute('data-thread-id')
    if (!selectedThreadId) throw new Error('Selected thread id is missing')
    await archiveRow.moveTo()
    const menuButton = archiveRow.$('.chat-menu-btn')
    await expect(menuButton).toHaveAttribute('aria-haspopup', 'menu')
    await expect(menuButton.$('[data-icon="more-vertical"]')).toBeExisting()
    await menuButton.click()
    const menu = await $('.context-menu').getElement()
    await menu.waitForDisplayed({ timeout: 5_000 })
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.context-menu-item')).map((i) => i.textContent),
    )
    expect(labels).toEqual(['Rename', 'Fork', 'Archive', 'Delete'])
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', selectedThreadId)
    await expect(archiveRow).toBeExisting()
    await saveAppScreenshot('thread-actions-menu.png')

    await browser.keys('Escape')
    await expect($('.context-menu')).not.toBeExisting()
    await archiveRow.click({ button: 'right' })
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    const rightClickLabels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.context-menu-item')).map((i) => i.textContent),
    )
    expect(rightClickLabels).toEqual(labels)
    await saveAppScreenshot('thread-context-menu-rename-archive.png')

    // Dismiss and exercise double-click rename on the keep thread.
    await browser.keys('Escape')
    await expect($('.context-menu')).not.toBeExisting()

    // Nested lookup — WDIO `*=` text match cannot be chained with a descendant
    // class in one selector (that would look for the literal text "... .chat-title").
    const keepRow = await $(`.chat-row*=${keepTitle}`).getElement()
    await keepRow.waitForExist({ timeout: 10_000 })
    // Electron/WDIO `doubleClick()` often does not synthesize a DOM `dblclick`
    // on the title; dispatch the event the component listens for.
    await browser.execute((title) => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('.chat-row')).find((r) =>
        (r.querySelector('.chat-title')?.textContent ?? '').includes(title),
      )
      const el = row?.querySelector('.chat-title')
      if (!(el instanceof HTMLElement)) throw new Error(`chat title not found for ${title}`)
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    }, keepTitle)
    const renameInput = await $('.chat-title-rename').getElement()
    await renameInput.waitForExist({ timeout: 5_000 })
    // Reclaim focus explicitly — WDIO can steal it between mount and setValue.
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('.chat-title-rename')
      if (!input) throw new Error('rename input missing before focus')
      input.focus()
      input.select()
    })
    await renameInput.setValue('Renamed keep thread')
    await browser.keys('Enter')

    await browser.waitUntil(
      async () => {
        const titles = await browser.execute(() =>
          Array.from(document.querySelectorAll('.chat-title')).map((n) => n.textContent),
        )
        return titles.includes('Renamed keep thread')
      },
      { timeout: 5_000, timeoutMsg: 'expected renamed thread title in sidebar' },
    )
    await saveElementScreenshot('#pane-projects', 'thread-renamed-sidebar.png')

    // Archive the other thread via context menu.
    const toArchive = await $(`.chat-row*=${archiveTitle}`).getElement()
    await toArchive.click({ button: 'right' })
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await $('.context-menu-item*=Archive').click()

    await browser.waitUntil(
      async () => {
        const titles = await browser.execute(() =>
          Array.from(document.querySelectorAll('.chat-title')).map((n) => n.textContent),
        )
        return titles.includes('Renamed keep thread') && !titles.includes(archiveTitle)
      },
      { timeout: 5_000, timeoutMsg: 'expected archived thread to leave the sidebar' },
    )
    await saveElementScreenshot('#pane-projects', 'thread-archived-sidebar.png')
  })

  it('terminal tab right-click offers Rename and Archive; double-click renames', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]').getElement()
    await terminalBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })

    // The host-terminal prompt appears only when there is no OS sandbox to be
    // outside of (`decideTerminalPermission`, permission-gate.ts). Linux used to
    // qualify unconditionally; since the ASRT Linux backend was enabled it
    // depends on the host having bubblewrap + socat, so observe rather than
    // assume — the same shape the second shell below already uses.
    const approval = await $('#approval-dialog').getElement()
    const unsandboxed = await approval
      .waitForDisplayed({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (unsandboxed) {
      await approval.$('.approval-approve').click()
      await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
    }

    await $('.terminals-tab').waitForExist({ timeout: 30_000 })

    // Second shell so Archive does not auto-spawn a replacement mid-assert.
    await $('.terminals-new-btn').click()
    if (process.platform !== 'darwin') {
      const approval = await $('#approval-dialog').getElement()
      const shown = await approval
        .waitForDisplayed({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
      if (shown) {
        await approval.$('.approval-approve').click()
        await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
      }
    }
    await browser.waitUntil(async () => (await $$('.terminals-tab').getElements()).length >= 2, {
      timeout: 10_000,
      timeoutMsg: 'expected two terminal tabs',
    })

    const firstTab = await $('.terminals-tab').getElement()
    await firstTab.click({ button: 'right' })
    const menu = await $('.context-menu').getElement()
    await menu.waitForDisplayed({ timeout: 5_000 })
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.context-menu-item')).map((i) => i.textContent),
    )
    expect(labels).toEqual(['Rename', 'Archive'])
    // Prefer element capture — full-app screenshots can blur the window and
    // dismiss the menu (context-menu listens for window `blur`).
    await saveElementScreenshot('.context-menu', 'terminal-context-menu-rename-archive.png')
    if (!(await $('.context-menu').isExisting())) {
      await firstTab.click({ button: 'right' })
      await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    }
    // Prefer mousedown in-page — WDIO `.click()` can blur the rename input in
    // the same turn as mount (menu already dismisses on mousedown).
    await browser.execute(() => {
      const item = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
      ).find((i) => i.textContent === 'Rename')
      if (!item) throw new Error('Rename menu item missing')
      item.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
      )
    })
    const renameInput = await $('.terminals-tab-rename').getElement()
    await renameInput.waitForExist({ timeout: 5_000 })
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('.terminals-tab-rename')
      if (!input) throw new Error('terminal rename input missing before focus')
      input.focus()
      input.select()
    })
    // WDIO's per-key typing can blur the field while terminal output repaints
    // the tab, saving a partial title. Set the field and commit in one DOM turn.
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('.terminals-tab-rename')
      if (!input) throw new Error('terminal rename input missing before commit')
      input.value = 'Build shell'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    await browser.waitUntil(
      async () => {
        const labels = await browser.execute(() =>
          Array.from(document.querySelectorAll('.terminals-tab-label')).map((n) => n.textContent),
        )
        return labels.includes('Build shell')
      },
      { timeout: 5_000, timeoutMsg: 'expected renamed terminal label' },
    )
    await saveElementScreenshot('#terminals-list-host', 'terminal-renamed-list.png')

    const tabCountBefore = (await $$('.terminals-tab').getElements()).length
    const buildTab = await $(`.terminals-tab*=Build shell`).getElement()
    await buildTab.click({ button: 'right' })
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await $('.context-menu-item*=Archive').click()

    await browser.waitUntil(
      async () => (await $$('.terminals-tab').getElements()).length === tabCountBefore - 1,
      { timeout: 5_000, timeoutMsg: 'expected archived terminal tab to close' },
    )
    await saveElementScreenshot('#terminals-list-host', 'terminal-archived-list.png')
  })
})
