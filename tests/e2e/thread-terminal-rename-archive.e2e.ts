import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedThreadRenameArchiveFixture } from './helpers/seed-config.ts'

describe('thread + terminal rename / archive', () => {
  let keepTitle: string
  let archiveTitle: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    ;({ keepTitle, archiveTitle } = seedThreadRenameArchiveFixture(process.cwd()))
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('double-click renames a thread; right-click offers Rename and Archive', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const archiveRow = await $(`.chat-row*=${archiveTitle}`)
    await archiveRow.waitForExist({ timeout: 10_000 })

    // Context menu on the thread that will be archived.
    await archiveRow.click({ button: 'right' })
    const menu = await $('.context-menu')
    await menu.waitForDisplayed({ timeout: 5_000 })
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.context-menu-item')).map((i) => i.textContent ?? ''),
    )
    expect(labels).toEqual(['Rename', 'Archive'])
    await saveAppScreenshot('thread-context-menu-rename-archive.png')

    // Dismiss and exercise double-click rename on the keep thread.
    await browser.keys('Escape')
    await expect($('.context-menu')).not.toBeExisting()

    const keepTitleEl = await $(`.chat-row*=${keepTitle} .chat-title`)
    await keepTitleEl.doubleClick()
    const renameInput = await $('.chat-title-rename')
    await renameInput.waitForExist({ timeout: 5_000 })
    await renameInput.setValue('Renamed keep thread')
    await browser.keys('Enter')

    await browser.waitUntil(
      async () => {
        const titles = await browser.execute(() =>
          Array.from(document.querySelectorAll('.chat-title')).map((n) => n.textContent ?? ''),
        )
        return titles.includes('Renamed keep thread')
      },
      { timeout: 5_000, timeoutMsg: 'expected renamed thread title in sidebar' },
    )
    await saveElementScreenshot('#pane-projects', 'thread-renamed-sidebar.png')

    // Archive the other thread via context menu.
    const toArchive = await $(`.chat-row*=${archiveTitle}`)
    await toArchive.click({ button: 'right' })
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await browser.execute(() => {
      const item = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
      ).find((i) => i.textContent === 'Archive')
      item?.click()
    })

    await browser.waitUntil(
      async () => {
        const titles = await browser.execute(() =>
          Array.from(document.querySelectorAll('.chat-title')).map((n) => n.textContent ?? ''),
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

    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })

    // Linux asks before opening a host terminal (no OS sandbox).
    if (process.platform !== 'darwin') {
      const approval = await $('#approval-dialog')
      await approval.waitForDisplayed({ timeout: 30_000 })
      await approval.$('.approval-approve').click()
      await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
    }

    await $('.terminals-tab').waitForExist({ timeout: 30_000 })

    // Second shell so Archive does not auto-spawn a replacement mid-assert.
    await $('.terminals-new-btn').click()
    if (process.platform !== 'darwin') {
      const approval = await $('#approval-dialog')
      const shown = await approval
        .waitForDisplayed({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
      if (shown) {
        await approval.$('.approval-approve').click()
        await approval.waitForDisplayed({ reverse: true, timeout: 10_000 })
      }
    }
    await browser.waitUntil(async () => (await $$('.terminals-tab')).length >= 2, {
      timeout: 10_000,
      timeoutMsg: 'expected two terminal tabs',
    })

    const firstTab = await $('.terminals-tab')
    await firstTab.click({ button: 'right' })
    const menu = await $('.context-menu')
    await menu.waitForDisplayed({ timeout: 5_000 })
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.context-menu-item')).map((i) => i.textContent ?? ''),
    )
    expect(labels).toEqual(['Rename', 'Archive'])
    await saveAppScreenshot('terminal-context-menu-rename-archive.png')

    await browser.execute(() => {
      const item = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
      ).find((i) => i.textContent === 'Rename')
      item?.click()
    })
    const renameInput = await $('.terminals-tab-rename')
    await renameInput.waitForExist({ timeout: 5_000 })
    await renameInput.setValue('Build shell')
    await browser.keys('Enter')

    await browser.waitUntil(
      async () => {
        const labels = await browser.execute(() =>
          Array.from(document.querySelectorAll('.terminals-tab-label')).map(
            (n) => n.textContent ?? '',
          ),
        )
        return labels.includes('Build shell')
      },
      { timeout: 5_000, timeoutMsg: 'expected renamed terminal label' },
    )
    await saveElementScreenshot('#terminals-list-host', 'terminal-renamed-list.png')

    const tabCountBefore = (await $$('.terminals-tab')).length
    const buildTab = await $(`.terminals-tab*=Build shell`)
    await buildTab.click({ button: 'right' })
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    await browser.execute(() => {
      const item = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.context-menu-item'),
      ).find((i) => i.textContent === 'Archive')
      item?.click()
    })

    await browser.waitUntil(
      async () => (await $$('.terminals-tab')).length === tabCountBefore - 1,
      { timeout: 5_000, timeoutMsg: 'expected archived terminal tab to close' },
    )
    await saveElementScreenshot('#terminals-list-host', 'terminal-archived-list.png')
  })
})
