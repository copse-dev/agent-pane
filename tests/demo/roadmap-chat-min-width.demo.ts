import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted roadmap side panel chat width', () => {
  before(async () => {
    await browser.url('/?scenario=roadmap-chat-min-width')
  })

  it('leaves chat at least one third of the available side-by-side width', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(() => {
      const roadmap = document.querySelector<HTMLElement>(
        '.titlebar-text-btn[aria-label="Open roadmap"]',
      )
      roadmap?.removeAttribute('hidden')
      roadmap?.removeAttribute('data-experimental-hidden')
    })
    await browser.execute(() =>
      document.querySelector<HTMLElement>('.titlebar-text-btn[aria-label="Open roadmap"]')?.click(),
    )
    await $('#roadmap-host').waitForDisplayed({ timeout: 10_000 })
    await expect($('#body')).not.toHaveElementClass('is-right-panel-horizontal')

    const layout = await browser.execute(() => {
      const projectsElement = document.getElementById('pane-projects')
      if (!projectsElement) throw new Error('Missing pane-projects fixture')
      const projects = projectsElement.getBoundingClientRect()
      const chatElement = document.getElementById('pane-chat')
      if (!chatElement) throw new Error('Missing pane-chat fixture')
      const chat = chatElement.getBoundingClientRect()
      const panelElement = document.getElementById('pane-files')
      if (!panelElement) throw new Error('Missing pane-files fixture')
      const panel = panelElement.getBoundingClientRect()
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
