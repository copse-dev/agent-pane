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
    // An empty thread with nothing running or waiting anywhere is the bare
    // composer, centred; the Activity home steps aside until there is something
    // to list.
    await $('.pane-chat.is-activity-idle').waitForExist({ timeout: 10_000 })
    await expect($('#activity-home')).not.toBeDisplayed()
    const idle = await browser.execute(() => {
      const input = document.getElementById('input-bar')
      const pane = document.getElementById('pane-chat')
      const conversation = document.getElementById('conversation')
      if (!input || !pane || !conversation) return null
      const bar = input.getBoundingClientRect()
      const frame = pane.getBoundingClientRect()
      return {
        barMid: (bar.top + bar.bottom) / 2,
        paneMid: (frame.top + frame.bottom) / 2,
        conversationDisplay: getComputedStyle(conversation).display,
        composerBorder: getComputedStyle(input).borderTopWidth,
      }
    })
    await expect(idle).not.toBeNull()
    if (!idle) throw new Error('Missing composer elements')
    await expect(Math.abs(idle.barMid - idle.paneMid)).toBeLessThanOrEqual(2)
    await expect(idle.conversationDisplay).toBe('none')
    await expect(idle.composerBorder).toBe('0px')
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'new-thread-activity-home.png'))

    await newThreadBtn.click()
    const blankRows = await $$('.chats-list .chat-row .chat-title')
    const titles = await blankRows.map((el) => el.getText())
    await expect(titles.filter((t) => t === 'New Thread').length).toBe(1)
  })
})
