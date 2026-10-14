import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedAcpUsageUpdateFixture,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('ACP usage_update context wheel', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    // The sidebar asynchronously reports unlanded work. The source checkout's
    // branch and edits must not determine a context-usage screenshot's badge.
    const workspace = seedStableWorkspace()
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workspace }).toString(), '')
    // Capture a deliberate, settled changes badge rather than assuming the
    // checkout stays clean while the app initializes its project integrations.
    appendFileSync(join(workspace, 'README.md'), '\nContext usage screenshot fixture.\n')
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: workspace }).toString(),
      ' M README.md\n',
    )
    seedAcpUsageUpdateFixture(workspace)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the agent-reported aggregate without a native prompt breakdown', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed()
    await expect(wheel.$('.context-wheel-label')).not.toExist()
    const track = wheel.$('.context-wheel-track')
    await expect((await track.getCSSProperty('stroke-dasharray')).value).toBe('none')
    // The aria-label also carries the usage line, replacing the removed counter's label.
    await expect(wheel).toHaveAttribute(
      'aria-label',
      /^Context 40% used, 80\.0k of 200\.0k tokens; Usage: 829 tokens/,
    )

    await browser.pause(500)
    await wheel.moveTo()
    const popover = wheel.$('.context-wheel-popover')
    await expect(popover).toBeDisplayed()
    await expect(popover.$('.context-wheel-popover-header')).toHaveText(
      'Context · 80.0k / 200.0k (40%)',
    )
    await expect(popover.$('.context-wheel-popover-note')).toHaveText('Reported by the agent')
    await expect(popover.$$('.context-wheel-popover-row')).toBeElementsArrayOfSize(0)
    await expect(popover.$('.footer-usage-popover-header')).toHaveText('Usage · 829 tokens')
    await expect(
      $('.chat-row[data-thread-id="e2e-acp-usage-update-thread"] .chat-changes-status'),
    ).toHaveAttribute('aria-label', 'Uncommitted changes')

    await saveAppScreenshot('acp-usage-update-context.png')
  })
})
