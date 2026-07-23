import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedToolDisplayFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('tool call turn rollup', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedToolDisplayFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows a multi-segment turn of italic rollups between Thinking blocks', async () => {
    await $('.tool-card-rollup').waitForExist({ timeout: 30_000 })

    const rollups = await $$('.tool-card-rollup')
    await expect(rollups).toBeElementsArrayOfSize(3)

    // Each assistant tool segment keeps its own polished italic summary.
    await expect(rollups[0]!.$('.tool-card-header .tool-name')).toHaveText(
      'Searched the settings UI',
    )
    await expect(rollups[1]!.$('.tool-card-header .tool-name')).toHaveText(
      'Inspected the repo layout · 1 failed',
    )
    await expect(rollups[2]!.$('.tool-card-header .tool-name')).toHaveText(
      'Read settings template paths',
    )

    // Tool-only segments leave Thinking open (empty message body).
    const openThinking = await $$('.msg-assistant .message-reasoning[open]')
    expect(openThinking.length).toBeGreaterThanOrEqual(2)

    const nameStyle = await browser.execute(() => {
      const el = document.querySelector('.tool-card-rollup > .tool-card-header .tool-name')
      if (!el) return null
      return getComputedStyle(el).fontStyle
    })
    expect(nameStyle).toBe('italic')

    // Pin the viewport to the start of the multi-segment turn so the overview
    // shows the user bug + Thinking / rollup pairs (not only the final answer).
    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = 0
    })
    await saveAppScreenshot('tool-display-rollup-collapsed.png')

    // Expand the mixed-success segment (second rollup) and capture detail.
    const mixed = rollups[1]!
    await mixed.scrollIntoView()
    await mixed.$('summary.tool-card-header').click()
    await expect(mixed).toHaveAttribute('open')
    await expect(mixed.$('.tool-card-group .tool-name')).toHaveText('Read files')
    await expect(mixed.$('.tool-card-group .tool-count')).toHaveText('×2')
    await expect(mixed.$('.tool-card[data-tool-id="tc-read-2"] .tool-name')).toHaveText(
      'Read file',
    )
    await expect(mixed.$('.tool-card[data-tool-id="tc-read-2"]')).toHaveAttribute(
      'data-status',
      'error',
    )

    await saveAppScreenshot('tool-display-rollup-expanded.png')
  })
})
