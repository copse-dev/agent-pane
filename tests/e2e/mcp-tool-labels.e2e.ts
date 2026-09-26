import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedMcpToolDisplayFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('MCP tool labels', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedMcpToolDisplayFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('hides raw ACP identifier titles and preserves native Copse labels', async () => {
    const run = $('.tool-card-rollup[data-rollup-key="run"]')
    await run.waitForExist({ timeout: 30_000 })
    await expect($$('.tool-card-rollup')).toBeElementsArrayOfSize(1)
    await expect(run.$('.tool-card-header .tool-name')).toHaveText('Used 8 tools · 1 failed')

    // Failed ACP tools stay visible without leaking their raw identifier title.
    const failed = $('[data-tool-id="tc-copse-error"]')
    await expect(failed).toBeDisplayed()
    await expect(failed.$('.tool-name')).toHaveText('Ran command')
    await expect(run).not.toHaveAttribute('open')
    await saveAppScreenshot('mcp-tool-labels-collapsed.png')

    // The same flat list covers dotted Codex names and double-underscore names.
    await run.$('summary.tool-card-header').click()
    await expect(run).toHaveAttribute('open')
    await expect(run.$$('.tool-rollup-body > .tool-card')).toBeElementsArrayOfSize(7)
    await expect(run.$$('.tool-card-step, .tool-card-group')).toBeElementsArrayOfSize(0)
    for (const [id, label] of [
      ['tc-mcp-create', 'Create Issue'],
      ['tc-copse-status', 'Checked git status'],
      ['tc-copse-diff', 'Viewed git diff'],
      ['tc-copse-shell', 'pnpm test'],
      ['tc-copse-read', 'Read file'],
    ]) {
      await expect(run.$(`[data-tool-id="${id}"] .tool-name`)).toHaveText(label)
    }

    const transcript = await browser.execute(() => {
      return document.querySelector('.messages-list')?.textContent ?? ''
    })
    expect(transcript).not.toContain('(MCP)')
    expect(transcript).not.toContain('github:')
    expect(transcript).not.toContain('copse:')
    expect(transcript).not.toContain('mcp.copse.')
    expect(transcript).not.toContain('mcp__copse__')

    await run.scrollIntoView()
    await saveAppScreenshot('mcp-tool-labels.png')
  })
})
