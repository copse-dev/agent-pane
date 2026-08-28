import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedMachineTurnAttributionFixture } from './helpers/seed-config.ts'

describe('machine turn attribution', function () {
  this.timeout(90_000)
  let workspaceRoot: string

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-machine-attribution-'))
    seedMachineTurnAttributionFixture(workspaceRoot)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('labels a machine prompt and explains that sends queue during a running turn', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const machineTurn = await $('.msg-machine-origin[data-operation-id="background-checks-17"]')
    await expect(machineTurn).toBeExisting()
    await expect(machineTurn.$('.msg-machine-origin-marker')).toHaveText(
      'Machine · automatic continuation',
    )

    await setComposerValue('Check the final diff. [[mock:delay_ms 15000]]')
    await $('.submit-btn').click()

    const running = await $('.footer-running')
    await running.waitForDisplayed({ timeout: 15_000 })
    await expect(running).toHaveText('Agent running · messages queue')
    await expect($('.submit-btn')).toHaveText('Queue')
    await expect($('.submit-btn')).toHaveAttribute('aria-label', 'Queue message')

    await setComposerValue('Then prepare the handoff summary.')
    await $('.submit-btn').click()
    await $('.conversation-queued .msg-queued').waitForExist({ timeout: 5_000 })
    await expect($('.conversation-queued .message-text')).toHaveText(
      'Then prepare the handoff summary.',
    )
    await expect($('.conversation-queued .message-queued-badge')).toHaveText('QUEUED')

    await saveAppScreenshot('machine-turn-attribution.png')
  })
})
