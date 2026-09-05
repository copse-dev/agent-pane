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
    // The three tool-only assistant messages form one run anchored on the
    // first, so the transcript shows a single collapsed summary rather than a
    // rollup per message.
    const run = $('.tool-card-rollup[data-rollup-key="run"]')
    await run.waitForExist({ timeout: 30_000 })
    await expect($$('.tool-card-rollup')).toBeElementsArrayOfSize(1)
    await expect(run.$('.tool-card-header .tool-name')).toHaveText('Used 5 tools · 3 steps')

    // Each step is headed by its message's own label: a lone MCP tool keeps its
    // humanised name, a same-server pair takes the server's display name, and
    // Copse's own tools keep their semantic group.
    await run.$('summary.tool-card-header').click()
    await expect(run).toHaveAttribute('open')
    const steps = await run.$$('.tool-card-step')
    await expect(steps).toBeElementsArrayOfSize(3)
    await expect(steps[0]!).toHaveAttribute('data-step-message-id', 'msg-assistant-mcp-single')
    await expect(steps[1]!).toHaveAttribute('data-step-message-id', 'msg-assistant-mcp-group')
    await expect(steps[2]!).toHaveAttribute('data-step-message-id', 'msg-assistant-copse-group')
    await expect(steps[0]!.$('.tool-card-header .tool-name')).toHaveText('Create Issue')
    await expect(steps[1]!.$('.tool-card-header .tool-name')).toHaveText('github')
    await expect(steps[2]!.$('.tool-card-header .tool-name')).toHaveText('Checked git')

    // The single tool's own card sits inside its step; open the step so the
    // card's label is rendered text rather than hidden `<details>` content.
    const single = steps[0]!
    await single.$('summary.tool-card-header').click()
    await expect(single).toHaveAttribute('open')
    await expect(single.$('.tool-card[data-tool-id="tc-mcp-create"] .tool-name')).toHaveText(
      'Create Issue',
    )

    const transcript = await browser.execute(() => {
      return document.querySelector('.messages-list')?.textContent ?? ''
    })
    expect(transcript).not.toContain('(MCP)')
    expect(transcript).not.toContain('github:')
    expect(transcript).not.toContain('copse:')

    await run.scrollIntoView()
    await saveAppScreenshot('mcp-tool-labels.png')
  })
})
