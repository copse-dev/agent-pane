import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-approval-cancel-settle'

interface ApprovalTestBridge {
  emitApprovalRequests: (requests: unknown) => Promise<void>
  cancelApprovalRequest: (id: string) => Promise<void>
}

describe('approval cancellation settle guard', function () {
  this.timeout(30_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('pauses a broadened primary action after a sibling is cancelled', async () => {
    await $('.prompt-input').waitForExist({ timeout: 20_000 })
    const requests = [
      {
        id: 'read-access',
        title: 'Allow read access outside of the project?',
        body: 'ls -la ~/.copse',
        bodyAdvice: 'The agent wants to read outside the project: ~/.copse',
        type: 'shell',
        collapseDetails: true,
        approveOnceLabel: 'Approve this command',
      },
      {
        id: 'sibling',
        title: 'Run command?',
        body: 'git status',
        type: 'shell',
      },
    ]
    await browser.execute(async (value) => {
      const bridge = (window as unknown as { __copseE2e?: ApprovalTestBridge }).__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      await bridge.emitApprovalRequests(value)
    }, requests)

    const dialog = $('#approval-dialog')
    await expect(dialog).toBeDisplayed()
    const approve = dialog.$('.approval-approve')
    const reject = dialog.$('.approval-reject')
    await expect(approve).toHaveText('Approve all (2)')

    await prepareE2eScreenshot()
    await browser.execute(async () => {
      const bridge = (window as unknown as { __copseE2e?: ApprovalTestBridge }).__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      await bridge.cancelApprovalRequest('sibling')
    })
    await expect(approve).toHaveText('Approve')
    assert.equal(await approve.isEnabled(), false)
    assert.equal(await reject.isEnabled(), true)
    await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'approval-cancel-settling.png'))

    await browser.waitUntil(async () => await approve.isEnabled(), {
      timeout: 2_000,
      timeoutMsg: 'approval did not re-enable after the cancellation settle window',
    })
  })
})
