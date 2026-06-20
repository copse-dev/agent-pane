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

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'mermaid-diagram-agent-loop.png'))
  })
})
