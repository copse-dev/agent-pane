import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-acp-network-scope-approval'
const REASON =
  'The sandbox network allowlist is temporarily widened for agent: codex; on macOS, this command could inherit that access if it starts now, so Copse is asking before running them at the same time.'
const EXPLANATION = `Why this needs approval:\n• ${REASON}`

describe('ACP network-scope overlap approval', function () {
  this.timeout(90_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID, { model: 'claude-sonnet-4-6' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('explains why another command needs approval while an ACP scope is widened', async () => {
    await $('.prompt-input').waitForExist({ timeout: 20_000 })
    await browser.execute((bodyFooter) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      void bridge.emitApprovalRequests([
        {
          id: 'acp-network-overlap',
          title: 'Run shell command?',
          body: 'npm test',
          bodyFooter,
          type: 'shell',
        },
      ])
    }, EXPLANATION)

    const dialog = $('#approval-dialog')
    await expect(dialog).toBeDisplayed()
    await expect(dialog.$('.approval-heading')).toHaveText('Run shell command?')
    await expect(dialog.$('.approval-body-code')).toHaveText('npm test')
    const footer = dialog.$('.approval-footer')
    await expect(footer).toHaveText(`Why this needs approval:\n${REASON}`)
    await expect(footer.$('ul.approval-reasons > li')).toHaveText(REASON)

    const geometry = await browser.execute(() => {
      const approval = document.querySelector<HTMLElement>('#approval-dialog')
      const footer = approval?.querySelector<HTMLElement>('.approval-footer')
      if (!approval || !footer) return null
      return {
        dialogOverflow: approval.scrollWidth > approval.clientWidth,
        footerOverflow: footer.scrollWidth > footer.clientWidth,
        footerHeight: footer.getBoundingClientRect().height,
      }
    })
    assert.ok(geometry)
    assert.equal(geometry.dialogOverflow, false)
    assert.equal(geometry.footerOverflow, false)
    assert.ok(geometry.footerHeight > 20, 'the explanation should wrap visibly')

    await prepareE2eScreenshot()
    await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'acp-network-scope-approval.png'))
    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
