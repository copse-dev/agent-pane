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

  it('rolls three tool-only segments into one run and keeps the lone segment per-message', async () => {
    await $('.tool-card-rollup').waitForExist({ timeout: 30_000 })

    // Two summaries, not four: the three prose-less segments are one run, and
    // the segment after the prose answer stands on its own.
    const rollups = await $$('.tool-card-rollup')
    await expect(rollups).toBeElementsArrayOfSize(2)
    await expect(rollups[0]!).toHaveAttribute('data-rollup-key', 'run')
    await expect(rollups[1]!).toHaveAttribute('data-rollup-key', 'turn')

    // The run's summary counts every member's operations and carries the
    // failure; the per-message rollup keeps its own polished label.
    await expect(rollups[0]!.$('.tool-card-header .tool-name')).toHaveText(
      'Used 10 tools · 3 steps · 1 failed',
    )
    await expect(rollups[1]!.$('.tool-card-header .tool-name')).toHaveText(
      'Verified the settings fix',
    )

    // The run renders on its anchor — the first segment of the burst — and the
    // members it absorbed render no cards of their own.
    await expect(
      $('[data-message-id="msg-assistant-search"] > .tool-card-rollup[data-rollup-key="run"]'),
    ).toExist()
    await expect($$('[data-message-id="msg-assistant-reads"] .tool-card')).toBeElementsArrayOfSize(
      0,
    )
    await expect($$('[data-message-id="msg-assistant-html"] .tool-card')).toBeElementsArrayOfSize(0)

    // Reasoning lives on each step, so no member keeps a standalone trail; only
    // the prose answer (which ran no tools) still has a body-level one.
    await expect($$('.msg-assistant .message-body > .message-reasoning')).toBeElementsArrayOfSize(1)

    const italicFont = await browser.execute(async () => {
      const el = document.querySelector('.tool-card-rollup > .tool-card-header .tool-name')
      if (!el) return null
      const style = getComputedStyle(el)
      await document.fonts.load(`${style.fontStyle} ${style.fontSize} ${style.fontFamily}`)
      return {
        style: style.fontStyle,
        hasLoadedFace: Array.from(document.fonts).some(
          (face) => face.family === 'Pliant' && face.style === 'italic' && face.status === 'loaded',
        ),
      }
    })
    expect(italicFont).toEqual({ style: 'italic', hasLoadedFace: true })

    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = 0
    })
    await saveAppScreenshot('tool-display-rollup-collapsed.png')
  })

  it('expands the run into one step per message, each with its own reasoning and tools', async () => {
    const run = await $('.tool-card-rollup[data-rollup-key="run"]')
    await run.scrollIntoView()
    await run.$('summary.tool-card-header').click()
    await expect(run).toHaveAttribute('open')

    // One step per persisted message, in the order they streamed, each headed
    // by that message's own polished label.
    const steps = await run.$$('.tool-card-step')
    await expect(steps).toBeElementsArrayOfSize(3)
    await expect(steps[0]!).toHaveAttribute('data-step-message-id', 'msg-assistant-search')
    await expect(steps[1]!).toHaveAttribute('data-step-message-id', 'msg-assistant-reads')
    await expect(steps[2]!).toHaveAttribute('data-step-message-id', 'msg-assistant-html')
    await expect(steps[0]!.$('.tool-card-header .tool-name')).toHaveText('Searched the settings UI')
    await expect(steps[1]!.$('.tool-card-header .tool-name')).toHaveText(
      'Inspected the repo layout · 1 failed',
    )
    await expect(steps[2]!.$('.tool-card-header .tool-name')).toHaveText(
      'Read settings template paths',
    )

    // Expand the mixed-success step: its reasoning and tool rows live inside it,
    // not on the run and not on the message bubble.
    const mixed = steps[1]!
    await mixed.scrollIntoView()
    await mixed.$('summary.tool-card-header').click()
    await expect(mixed).toHaveAttribute('open')
    await expect(mixed.$('.tool-rollup-body > .message-reasoning')).toExist()
    await expect(mixed.$('.message-reasoning-title')).toHaveText('Reasoned')
    await expect(mixed.$('.message-reasoning-text')).toHaveText(
      'Reading key files to diagnose the settings flicker and missing button text.',
    )
    await expect(mixed.$('.tool-card-group .tool-name')).toHaveText('Read files')
    await expect(mixed.$('.tool-card-group .tool-count')).toHaveText('×2')
    await expect(mixed.$('.tool-card[data-tool-id="tc-read-2"] .tool-name')).toHaveText('Read file')
    await expect(mixed.$('.tool-card[data-tool-id="tc-read-2"]')).toHaveAttribute(
      'data-status',
      'error',
    )

    // The run adds exactly one rail: the run body, then the step body. Groups
    // below a step inset without a rule of their own.
    const railDepth = await browser.execute(() => {
      const errored = document.querySelector('.tool-card[data-tool-id="tc-read-2"]')
      if (!errored) return null
      let rails = 0
      for (let el = errored.parentElement; el; el = el.parentElement) {
        if (el.classList.contains('msg')) break
        if (getComputedStyle(el).borderLeftStyle !== 'none') rails += 1
      }
      return rails
    })
    expect(railDepth).toBe(2)

    // Nested success rows keep their own color even when the step is mixed.
    const iconColors = await browser.execute(() => {
      const success = document.querySelector(
        '.tool-card-step[data-status="error"] .tool-card-group[data-status="done"] > .tool-card-header > .tool-status-icon',
      )
      const failure = document.querySelector(
        '.tool-card-step[data-status="error"] .tool-card[data-status="error"] > .tool-card-header > .tool-status-icon',
      )
      return {
        success: success ? getComputedStyle(success).color : null,
        failure: failure ? getComputedStyle(failure).color : null,
      }
    })
    expect(iconColors.success).toBeTruthy()
    expect(iconColors.failure).toBeTruthy()
    expect(iconColors.success).not.toBe(iconColors.failure)

    await saveAppScreenshot('tool-display-rollup-expanded.png')
  })
})
