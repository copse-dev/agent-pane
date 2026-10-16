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
      document
        .querySelector<HTMLElement>('.titlebar-text-btn[aria-label=\"Open roadmap\"]')
        ?.click(),
    )
    await $('#roadmap-host').waitForDisplayed({ timeout: 10_000 })
    await expect($('#body')).not.toHaveElementClass('is-right-panel-horizontal')

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

  it('keeps the import view inset from the viewer edges', async () => {
    await $('.roadmap-import-btn').click()
    await $('.roadmap-import').waitForDisplayed()
    const bounds = await browser.execute(() => {
      const viewer = document.querySelector('.roadmap-viewer')
      const content = document.querySelector('.roadmap-import')
      if (!viewer || !content) throw new Error('expected the roadmap import view')
      const outer = viewer.getBoundingClientRect()
      const inner = content.getBoundingClientRect()
      return {
        left: inner.left - outer.left,
        right: outer.right - inner.right,
        top: inner.top - outer.top,
        bottom: outer.bottom - inner.bottom,
      }
    })
    for (const edge of Object.values(bounds)) assert.ok(edge >= 11, 'preserve the 12px inset')
    await saveAppScreenshot('roadmap-import-viewer-inset.png')
  })
})
