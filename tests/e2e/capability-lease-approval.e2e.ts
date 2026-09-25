import assert from 'node:assert/strict'
import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

describe('turn-tree shell replay approval', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-capability-lease', {
      autoRunSandboxCommands: false,
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    resetUserData()
  })

  it('includes bounded task retries in a sandboxed approval by default', async function () {
    this.timeout(90_000)
    await prepareMockToolTurn(
      'Retry the local version command exactly once',
      { name: 'run_shell', args: { command: 'node --version' } },
      'The version command was declined.',
    )
    await submitComposer()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Run shell command?')
    // Why it is asking renders as a real list of sentence-case reasons, not a
    // hand-drawn "•" line with a lowercase fragment.
    const footer = dialog.$('.approval-footer')
    await expect(footer).toHaveText(expect.stringContaining('Why this needs approval:'))
    const reasons = await footer.$$('ul.approval-reasons > li').map((item) => item.getText())
    assert.deepEqual(reasons, ['Auto-run for sandbox commands is disabled in Settings'])
    assert.doesNotMatch(await footer.getText(), /\u2022/)
    await saveElementScreenshot('#approval-dialog', 'approval-reasons-list.png')

    const leaseOption = dialog.$('.approval-turn-tree')
    await expect(leaseOption).toBeDisplayed()
    await expect(leaseOption).toHaveText('Allow retries for this task (up to 10, for 15 minutes)')
    await expect(leaseOption.$('.approval-turn-tree-input')).toBeChecked()

    await saveAppScreenshot('capability-lease-approval.png')
    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
