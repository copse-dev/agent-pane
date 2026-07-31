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

  it('hides internal server prefixes and preserves semantic Copse groups', async () => {
    const createIssue = $('.tool-card[data-tool-id="tc-mcp-create"]')
    await createIssue.waitForExist({ timeout: 30_000 })
    await expect(createIssue.$('.tool-name')).toHaveText('Create Issue')

    const rollups = await $$('.tool-card-rollup')
    await expect(rollups).toBeElementsArrayOfSize(2)
    await expect(rollups[0]!.$('.tool-name')).toHaveText('github')
    await expect(rollups[1]!.$('.tool-name')).toHaveText('Checked git')

    await rollups[0]!.$('summary.tool-card-header').click()
    await rollups[1]!.$('summary.tool-card-header').click()
    await expect(rollups[0]!.$('.tool-card-group .tool-name')).toHaveText('github')
    await expect(rollups[1]!.$('.tool-card-group .tool-name')).toHaveText('Checked git')

    const transcript = await browser.execute(() => {
      return document.querySelector('.messages-list')?.textContent ?? ''
    })
    expect(transcript).not.toContain('(MCP)')
    expect(transcript).not.toContain('github:')
    expect(transcript).not.toContain('copse:')

    await rollups[1]!.scrollIntoView()
    await saveAppScreenshot('mcp-tool-labels.png')
  })
})
