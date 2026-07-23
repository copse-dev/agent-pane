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

  it('nests Reasoning inside italic tool rollups across a multi-segment turn', async () => {
    await $('.tool-card-rollup').waitForExist({ timeout: 30_000 })

    const rollups = await $$('.tool-card-rollup')
    await expect(rollups).toBeElementsArrayOfSize(3)

    // Each tool segment collapses to one italic heading — no standalone Reasoning above.
    await expect(rollups[0]!.$('.tool-card-header .tool-name')).toHaveText(
      'Searched the settings UI',
    )
    await expect(rollups[1]!.$('.tool-card-header .tool-name')).toHaveText(
      'Inspected the repo layout · 1 failed',
    )
    await expect(rollups[2]!.$('.tool-card-header .tool-name')).toHaveText(
      'Read settings template paths',
    )
    await expect($$('.msg-assistant .message-body > .message-reasoning')).toBeElementsArrayOfSize(1)

    const nameStyle = await browser.execute(() => {
      const el = document.querySelector('.tool-card-rollup > .tool-card-header .tool-name')
      if (!el) return null
      return getComputedStyle(el).fontStyle
    })
    expect(nameStyle).toBe('italic')

    await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      if (list) list.scrollTop = 0
    })
    await saveAppScreenshot('tool-display-rollup-collapsed.png')

    // Expand the mixed-success segment: Reasoning + flat tool rows live inside.
    const mixed = rollups[1]!
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

    // Nested success rows keep their own color even when the rollup is mixed.
    const iconColors = await browser.execute(() => {
      const success = document.querySelector(
        '.tool-card-rollup[data-status="error"] .tool-card-group[data-status="done"] > .tool-card-header > .tool-status-icon',
      )
      const failure = document.querySelector(
        '.tool-card-rollup[data-status="error"] .tool-card[data-status="error"] > .tool-card-header > .tool-status-icon',
      )
      return {
        success: success ? getComputedStyle(success).color : null,
        failure: failure ? getComputedStyle(failure).color : null,
        successToken: getComputedStyle(document.documentElement)
          .getPropertyValue('--success')
          .trim(),
        errorToken: getComputedStyle(document.documentElement).getPropertyValue('--error').trim(),
      }
    })
    expect(iconColors.success).toBeTruthy()
    expect(iconColors.failure).toBeTruthy()
    expect(iconColors.success).not.toBe(iconColors.failure)

    await saveAppScreenshot('tool-display-rollup-expanded.png')
  })
})
