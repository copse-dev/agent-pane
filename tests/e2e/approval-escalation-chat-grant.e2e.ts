import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { escalationGrantFooter } from '../../src/main/services/security/escalation-grant.ts'
import { gitPushApproval, gitPushChatGrantCopy } from '../../src/shared/approval-copy.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-approval-escalation-chat-grant'

describe('outside-sandbox prompt with a chat grant', function () {
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

  it('offers Run once as the primary answer and Allow for this chat beside it', async () => {
    await $('.prompt-input').waitForExist({ timeout: 20_000 })
    // The fields permission-gate's requestEscalationApproval sends for a
    // command whose only reasons are grantable kinds, with its real footer.
    const footer = escalationGrantFooter([
      'global temp path (/tmp/)',
      'loopback request (curl/wget)',
    ])
    const request = {
      id: 'escalation-chat-grant',
      title: 'Run outside sandbox?',
      body: 'curl -s -c /tmp/rider_cookies.txt http://localhost:3000/api/me',
      bodyAdvice: 'Uses the machine-wide temp directory (/tmp)',
      bodyFooter: footer,
      type: 'shell',
      allowRemember: true,
      approveLabel: 'Allow for this chat',
      approveOnceLabel: 'Run once',
    }
    await browser.execute(async (value) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      await bridge.emitApprovalRequests([value])
    }, request)

    const dialog = $('#approval-dialog')
    await expect(dialog).toBeDisplayed()
    const once = dialog.$('.approval-approve-once')
    const grant = dialog.$('.approval-approve')
    await expect(once).toBeDisplayed()
    await expect(once).toHaveText('Run once')
    await expect(once).toHaveElementClass('ui-btn-primary')
    await expect(grant).toHaveText('Allow for this chat')
    await expect(dialog).toHaveText(
      expect.stringContaining('only involve /tmp files and requests to this machine'),
    )

    await prepareE2eScreenshot()
    await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'approval-escalation-chat-grant.png'))
    await dialog.$('.approval-reject').click()
    await expect(dialog).not.toBeDisplayed()
  })

  it('offers Push once and Allow for this chat on a push of the thread branch', async () => {
    const branch = 'copse/restore-the-pink-hero-banner'
    const request = {
      id: 'push-chat-grant',
      ...gitPushApproval(branch),
      ...gitPushChatGrantCopy(branch),
      type: 'mcp',
      allowRemember: true,
    }
    await browser.execute(async (value) => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      await bridge.emitApprovalRequests([value])
    }, request)

    const dialog = $('#approval-dialog')
    await expect(dialog).toBeDisplayed()
    await expect(dialog).toHaveText(expect.stringContaining('Push branch to origin?'))
    const once = dialog.$('.approval-approve-once')
    await expect(once).toHaveText('Push once')
    await expect(once).toHaveElementClass('ui-btn-primary')
    await expect(dialog.$('.approval-approve')).toHaveText('Allow for this chat')
    await expect(dialog).toHaveText(expect.stringContaining('fast-forward only'))

    await prepareE2eScreenshot()
    await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'approval-push-chat-grant.png'))
  })
})
