import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedToolDisplayFixture } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

describe('compact tool activity', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedToolDisplayFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('keeps successful work quiet while showing a failed tool directly', async () => {
    await $('.tool-card-rollup').waitForExist({ timeout: 30_000 })
    await expect($$('.tool-card-rollup')).toBeElementsArrayOfSize(2)
    const run = $('.tool-card-rollup[data-rollup-key="run"]')
    await expect(run).not.toHaveAttribute('open')
    await expect(run.$('.tool-card-header .tool-name')).toHaveText('Used 10 tools · 1 failed')
    const failure = $('.msg > .tool-card[data-tool-id="tc-read-2"]')
    await expect(failure).toHaveAttribute('open')
    await expect(failure.$('.tool-result')).toHaveText(expect.stringContaining('ENOENT'))
    await expect($$('.message-reasoning[open]')).toBeElementsArrayOfSize(0)
    await expect($$('.tool-card-step')).toBeElementsArrayOfSize(0)

    const layout = await browser.execute(() => {
      const members = ['msg-assistant-reads', 'msg-assistant-html'].map((id) => {
        const node = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        return node
          ? { display: getComputedStyle(node).display, height: node.getBoundingClientRect().height }
          : null
      })
      const summary = document.querySelector('.tool-card-rollup > summary')
      return { members, summaryHeight: summary?.getBoundingClientRect().height ?? 0 }
    })
    expect(layout.members).toEqual([
      { display: 'none', height: 0 },
      { display: 'none', height: 0 },
    ])
    expect(layout.summaryHeight).toBeGreaterThan(0)
    expect(layout.summaryHeight).toBeLessThan(32)
    await run.scrollIntoView()
    await saveAppScreenshot('tool-display-rollup-collapsed.png')
  })

  it('expands to a flat list with one quiet reasoning disclosure', async () => {
    const run = $('.tool-card-rollup[data-rollup-key="run"]')
    await run.$('summary.tool-card-header').click()
    await expect(run).toHaveAttribute('open')
    await expect(run.$$('.tool-rollup-body > .tool-card')).toBeElementsArrayOfSize(9)
    await expect(
      run.$$('.tool-card-step, .tool-card-group, .tool-card-rollup'),
    ).toBeElementsArrayOfSize(0)
    await expect(run.$$('.message-reasoning')).toBeElementsArrayOfSize(1)
    const reasoning = run.$('.message-reasoning')
    await expect(reasoning).not.toHaveAttribute('open')
    await reasoning.$('summary').click()
    await expect(reasoning).toHaveAttribute('open')
    await expect(reasoning.$('[data-reasoning-message-id="msg-assistant-reads"]')).toHaveText(
      'Reading key files to diagnose the settings flicker and missing button text.',
    )
    const material = await browser.execute(() => {
      const reasoning = document.querySelector('.tool-card-rollup .message-reasoning[open]')
      if (!reasoning) throw new Error('Missing expanded reasoning')
      const style = getComputedStyle(reasoning)
      return {
        background: style.backgroundImage,
        border: style.borderLeftWidth,
        padding: style.padding,
        shadow: style.boxShadow,
      }
    })
    expect(material).toEqual({ background: 'none', border: '0px', padding: '0px', shadow: 'none' })
    await saveElementScreenshot(
      '.tool-card-rollup .message-reasoning[open]',
      'reasoning-etched-in-tool-rollup.png',
    )
    await reasoning.$('summary').click()

    const tool = run.$('[data-tool-id="tc-read-1"]')
    await tool.$('summary').click()
    await expect(tool).toHaveAttribute('open')
    await expect(tool.$('.tool-result')).toBeDisplayed()
    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = 0
    })
    await saveAppScreenshot('tool-display-rollup-expanded.png')
  })
})
