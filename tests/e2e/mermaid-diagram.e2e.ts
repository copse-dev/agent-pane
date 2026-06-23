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

    // The diagram SVG is produced by lazy-loading the (large) `mermaid` bundle and
    // then rendering it through DOMPurify (securityLevel 'strict', see
    // src/renderer/markdown/mermaid.ts). That import-plus-sanitize cost is the
    // heaviest single step in the CI gate and occasionally overran the old 20s
    // budget on the 2-core GitHub runner (fail-then-pass-on-retry). Give it real
    // headroom so the spec passes on the first attempt instead of leaning on the
    // shard-level retry.
    await browser.waitUntil(
      async () => {
        const svg = await $('.message-text .mermaid-diagram svg')
        return svg.isExisting()
      },
      {
        timeout: 40_000,
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
      const composer = document.getElementById('input-bar')
      const pane = document.getElementById('pane-chat')
      const inputRect = input?.getBoundingClientRect()
      const composerRect = composer?.getBoundingClientRect()
      const paneRect = pane?.getBoundingClientRect()
      const composerHeight = pane
        ? Number.parseFloat(getComputedStyle(pane).getPropertyValue('--chat-composer-height'))
        : 0
      return {
        inputExists: Boolean(input),
        inputInViewport:
          inputRect != null &&
          inputRect.height > 0 &&
          inputRect.bottom <= window.innerHeight &&
          inputRect.top >= 0,
        composerNearPaneBottom:
          composerRect != null &&
          paneRect != null &&
          Math.abs(composerRect.bottom - paneRect.bottom) < 4,
        composerHeight,
      }
    })
    expect(chrome.inputExists).toBe(true)
    expect(chrome.inputInViewport).toBe(true)
    expect(chrome.composerNearPaneBottom).toBe(true)
    expect(chrome.composerHeight).toBeGreaterThan(72)

    await $('.mermaid-diagram--folded').waitForExist({ timeout: 10_000 })
    await $('.mermaid-diagram--folded').click()
    await $('dialog.mermaid-expand-dialog[open]').waitForExist({ timeout: 10_000 })
    await expect($('dialog.mermaid-expand-dialog svg')).toExist()
    await expect($('.mermaid-expand-viewport')).toExist()
    await expect($('.mermaid-expand-toolbar')).toExist()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'mermaid-diagram-agent-loop.png'))
  })
})
