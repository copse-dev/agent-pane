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

  it('hides internal server prefixes and raw ACP identifier titles', async () => {
    // The three tool-only assistant messages form one run anchored on the
    // first, so the transcript shows a single collapsed summary rather than a
    // rollup per message.
    const run = $('.tool-card-rollup[data-rollup-key="run"]')
    await run.waitForExist({ timeout: 30_000 })
    await expect($$('.tool-card-rollup')).toBeElementsArrayOfSize(1)
    await expect(run.$('.tool-card-header .tool-name')).toHaveText(
      'Used 8 tools · 3 steps · 1 failed',
    )

    // The failed ACP tool stays visible beside the collapsed run, labelled as
    // the native Copse tool rather than by its raw `mcp.copse.` identifier.
    const failed = $(
      '[data-message-id="msg-assistant-mcp-single"] > [data-tool-id="tc-copse-error"]',
    )
    await expect(failed).toBeDisplayed()
    await expect(failed).toHaveAttribute('open')
    await expect(failed.$('.tool-name')).toHaveText('Ran command')
    await expect(run).not.toHaveAttribute('open')
    await expect(run.$('[data-tool-id="tc-copse-error"]')).not.toExist()
    await saveAppScreenshot('mcp-tool-labels-collapsed.png')

    // Each step is headed by its message's own label: a lone MCP tool keeps its
    // humanised name, a same-server pair takes the server's display name, and
    // Copse's mixed tools count their operations and the failure.
    await run.$('summary.tool-card-header').click()
    await expect(run).toHaveAttribute('open')
    const steps = await run.$$('.tool-card-step')
    await expect(steps).toBeElementsArrayOfSize(3)
    await expect(steps[0]!).toHaveAttribute('data-step-message-id', 'msg-assistant-mcp-single')
    await expect(steps[1]!).toHaveAttribute('data-step-message-id', 'msg-assistant-mcp-group')
    await expect(steps[2]!).toHaveAttribute('data-step-message-id', 'msg-assistant-copse-group')
    await expect(steps[0]!.$('.tool-card-header .tool-name')).toHaveText('Create issue')
    await expect(steps[1]!.$('.tool-card-header .tool-name')).toHaveText('github')
    await expect(steps[2]!.$('.tool-card-header .tool-name')).toHaveText('Used 5 tools · 1 failed')

    // The single tool's own card sits inside its step; open the step so the
    // card's label is rendered text rather than hidden `<details>` content.
    const single = steps[0]!
    await single.$('summary.tool-card-header').click()
    await expect(single).toHaveAttribute('open')
    await expect(single.$('.tool-card[data-tool-id="tc-mcp-create"] .tool-name')).toHaveText(
      'Create issue',
    )

    // Dotted Codex names and double-underscore names both take the native
    // Copse labels, and Copse's git wrappers keep their semantic group.
    const copse = steps[2]!
    await copse.$('summary.tool-card-header').click()
    await expect(copse).toHaveAttribute('open')
    const git = copse.$('.tool-card-group')
    await expect(git.$(':scope > summary .tool-name')).toHaveText('Checked git')
    await git.$(':scope > summary').click()
    await expect(git).toHaveAttribute('open')
    await expect(git.$('[data-tool-id="tc-copse-status"] .tool-name')).toHaveText(
      'Checked git status',
    )
    await expect(git.$('[data-tool-id="tc-copse-diff"] .tool-name')).toHaveText('Viewed git diff')
    await expect(copse.$('.tool-card[data-tool-id="tc-copse-shell"] .tool-name')).toHaveText(
      'pnpm test',
    )
    await expect(copse.$('.tool-card[data-tool-id="tc-copse-read"] .tool-name')).toHaveText(
      'Read file',
    )

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
