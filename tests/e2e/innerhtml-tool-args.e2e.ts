import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { renderToolArgs } from '../../src/renderer/views/tool-args-format.ts'
import {
  INNERHTML_TRAP_ARGS,
  resetUserData,
  seedInnerHtmlToolArgsFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

describe('innerHTML-safe tool args', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedInnerHtmlToolArgsFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders tool args with </pre> without breaking card markup', async () => {
    await $('.tool-card[data-tool-id="tc-write-trap"]').waitForExist({ timeout: 30_000 })

    const toolCard = await $('.tool-card[data-tool-id="tc-write-trap"]')
    await expect(toolCard.$('.tool-name')).toHaveText('Edited index.html')
    await expect(toolCard.$('.tool-stat-add')).toHaveText('+1')
    await expect(toolCard.$('.tool-stat-del')).toHaveText('-0')
    await expect(toolCard).toHaveAttribute('data-status', 'done')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'innerhtml-tool-args-collapsed.png'))

    await toolCard.$('summary.tool-card-header').click()

    // The Arguments disclosure takes the transcript's text-chevron handle, not
    // the UA triangle in primary text.
    const summaryStyle = (): Promise<{
      listStyle: string
      marker: string
      color: string
      muted: string
    } | null> =>
      browser.execute(() => {
        const summary = document.querySelector(
          '.tool-card[data-tool-id="tc-write-trap"] > .tool-args > summary',
        )
        if (!(summary instanceof HTMLElement)) return null
        const probe = document.createElement('div')
        probe.style.color = 'var(--text-muted)'
        document.body.append(probe)
        const muted = getComputedStyle(probe).color
        probe.remove()
        const style = getComputedStyle(summary)
        return {
          listStyle: style.listStyleType,
          marker: getComputedStyle(summary, '::before').content,
          color: style.color,
          muted,
        }
      })
    const closed = await summaryStyle()
    expect(closed).not.toBeNull()
    expect(closed!.listStyle).toBe('none')
    expect(closed!.marker).toBe('"▸ "')
    expect(closed!.color).toBe(closed!.muted)

    await toolCard.$('.tool-args summary').click()
    const opened = await summaryStyle()
    expect(opened!.marker).toBe('"▾ "')

    const argsPre = toolCard.$('.tool-args pre')
    await expect(argsPre).toHaveText(renderToolArgs(INNERHTML_TRAP_ARGS))
    await expect(argsPre).toHaveText('</pre>', { containing: true })

    await expect(toolCard.$$('img')).toBeElementsArrayOfSize(0)
    await expect(toolCard.$$('.tool-args pre')).toBeElementsArrayOfSize(1)

    // Park the pointer off the summary so the shot shows its resting (muted) colour.
    await argsPre.moveTo()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'innerhtml-tool-args-expanded.png'))
  })
})
