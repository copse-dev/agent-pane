import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eThreePaneLayout, seedEmptyProject } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveAppScreenshot,
} from './helpers/screenshot.ts'

describe('roadmap side panel chat width', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-roadmap-chat-min-width', {
      roadmapPlansEnabled: true,
    })
    // Reproduce an oversized width persisted from a larger window.
    seedE2eThreePaneLayout({ filesPaneWidth: 4000 })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('leaves chat at least one third of the available side-by-side width', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.titlebar-text-btn[aria-label="Open roadmap"]').click()
    await $('#roadmap-host').waitForDisplayed({ timeout: 10_000 })
    await expect($('#body')).not.toHaveElementClass('is-right-panel-horizontal')
    await prepareE2eScreenshot()

    const layout = await browser.execute(() => {
      const projects = document.getElementById('pane-projects')!.getBoundingClientRect()
      const chat = document.getElementById('pane-chat')!.getBoundingClientRect()
      const panel = document.getElementById('pane-files')!.getBoundingClientRect()
      const sharedWidth = chat.width + panel.width
      return {
        chatWidth: chat.width,
        panelWidth: panel.width,
        projectsWidth: projects.width,
        sharedWidth,
      }
    })

    assert.ok(layout.projectsWidth > 0)
    assert.ok(layout.panelWidth > 0)
    assert.ok(
      layout.chatWidth >= layout.sharedWidth / 3 - 2,
      `chat was ${String(layout.chatWidth)}px of ${String(layout.sharedWidth)}px shared width`,
    )
    assert.ok(layout.panelWidth <= (layout.sharedWidth * 2) / 3 + 2)

    await saveAppScreenshot('roadmap-chat-min-width.png')
  })
})
