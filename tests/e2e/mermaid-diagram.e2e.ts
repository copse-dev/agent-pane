import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedMermaidDiagramFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('mermaid diagram rendering', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedMermaidDiagramFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders mermaid fenced blocks as SVG diagrams', async () => {
    await $('.message-text .mermaid-diagram').waitForExist({ timeout: 15_000 })

    await browser.waitUntil(
      async () => {
        const svg = await $('.message-text .mermaid-diagram svg')
        return svg.isExisting()
      },
      {
        timeout: 20_000,
        timeoutMsg: 'expected mermaid diagram SVG to render',
      },
    )

    const layout = await browser.execute(() => {
      const root = document.querySelector('.message-text')
      const diagram = root?.querySelector('.mermaid-diagram')
      const pre = diagram?.querySelector('pre.mermaid')
      return {
        hasDiagramContainer: Boolean(diagram),
        hasSvg: Boolean(diagram?.querySelector('svg')),
        preProcessed: pre?.getAttribute('data-processed') === 'true',
        listsInsideParagraphs: root?.querySelectorAll('p .mermaid-diagram').length ?? 0,
      }
    })

    expect(layout.hasDiagramContainer).toBe(true)
    expect(layout.hasSvg).toBe(true)
    expect(layout.preProcessed).toBe(true)
    expect(layout.listsInsideParagraphs).toBe(0)

    const chrome = await browser.execute(() => {
      const input = document.querySelector('.prompt-input')
      const pane = document.getElementById('pane-chat')
      const rect = input?.getBoundingClientRect()
      const paneRect = pane?.getBoundingClientRect()
      const composerHeight = pane
        ? Number.parseFloat(getComputedStyle(pane).getPropertyValue('--chat-composer-height'))
        : 0
      return {
        inputExists: Boolean(input),
        inputInViewport:
          rect != null && rect.height > 0 && rect.bottom <= window.innerHeight && rect.top >= 0,
        inputNearPaneBottom:
          rect != null && paneRect != null && Math.abs(rect.bottom - paneRect.bottom) < 4,
        composerHeight,
      }
    })
    expect(chrome.inputExists).toBe(true)
    expect(chrome.inputInViewport).toBe(true)
    expect(chrome.inputNearPaneBottom).toBe(true)
    expect(chrome.composerHeight).toBeGreaterThan(72)

    await $('.mermaid-diagram--folded').waitForExist({ timeout: 5_000 })
    await $('.mermaid-diagram--folded').click()
    await $('dialog.mermaid-expand-dialog[open]').waitForExist({ timeout: 5_000 })
    await expect($('dialog.mermaid-expand-dialog svg')).toExist()
    await expect($('.mermaid-expand-viewport')).toExist()
    await expect($('.mermaid-expand-toolbar')).toExist()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'mermaid-diagram-agent-loop.png'))
  })
})
