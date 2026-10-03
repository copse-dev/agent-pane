import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('titlebar workspace name', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-titlebar-'))
    seedEmptyProject(workspaceRoot, 'e2e-titlebar-project')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('shows the active project folder name after restoring on launch', async () => {
    const workspaceName = await $('.workspace-name')
    await workspaceName.waitForExist({ timeout: 30_000 })
    await expect(workspaceName).toHaveText(basename(workspaceRoot))
    await expect(workspaceName).not.toHaveText('No folder')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'titlebar-workspace-name.png'))

    const newThreadBtn = await $('.project-new-thread-btn')
    await expect(newThreadBtn).toBeDisplayed()
    await newThreadBtn.click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('New Thread')
    // An empty thread is the Activity home: the list sits above a docked
    // composer, never behind it, and nothing spills sideways.
    await $('.pane-chat.is-activity-home').waitForExist({ timeout: 10_000 })
    await expect($('#activity-home')).toBeDisplayed()
    const home = await browser.execute(() => {
      const root = document.getElementById('activity-home')
      const body = root?.querySelector('.activity-panel-body')
      const input = document.getElementById('input-bar')
      const conversation = document.getElementById('conversation')
      if (!root || !body || !input || !conversation) return null
      return {
        bodyBottom: body.getBoundingClientRect().bottom,
        inputTop: input.getBoundingClientRect().top,
        overflowsSideways: root.scrollWidth > root.clientWidth,
        conversationDisplay: getComputedStyle(conversation).display,
        composerBorder: getComputedStyle(input).borderTopWidth,
      }
    })
    await expect(home).not.toBeNull()
    if (!home) throw new Error('Missing Activity home elements')
    await expect(home.bodyBottom).toBeLessThanOrEqual(home.inputTop + 1)
    await expect(home.overflowsSideways).toBe(false)
    await expect(home.conversationDisplay).toBe('none')
    await expect(home.composerBorder).toBe('1px')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'new-thread-activity-home.png'))

    await newThreadBtn.click()
    const blankRows = await $$('.chats-list .chat-row .chat-title')
    const titles = await blankRows.map((el) => el.getText())
    await expect(titles.filter((t) => t === 'New Thread').length).toBe(1)
  })
})
