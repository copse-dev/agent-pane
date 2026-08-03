import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import type { MockScriptStep } from '../../src/shared/llm/mock-script.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const SCRIPT = [
  {
    when: 'retry.*version',
    tool: { name: 'run_shell', args: { command: 'node --version' } },
  },
] satisfies MockScriptStep[]

async function installMockScript(): Promise<void> {
  await browser.execute(async (script) => {
    const bridge = (
      window as unknown as {
        __copseE2e?: { setMockScript: (value: unknown) => Promise<unknown> }
      }
    ).__copseE2e
    if (!bridge) throw new Error('__copseE2e unavailable')
    await bridge.setMockScript(script)
  }, SCRIPT)
}

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
    await installMockScript()
  })

  after(async () => {
    await browser.execute(async () => {
      await (
        window as unknown as { __copseE2e?: { clearMockScript: () => Promise<void> } }
      ).__copseE2e?.clearMockScript?.()
    })
    resetUserData()
  })

  it('defaults a sandboxed command to bounded task retries', async function () {
    this.timeout(90_000)
    await setComposerValue('Retry the local version command exactly once')
    await $('.submit-btn').click()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Run shell command?')
    const leaseOption = dialog.$('.approval-turn-tree')
    await expect(leaseOption).toBeDisplayed()
    await expect(leaseOption).toHaveText('Allow 2 exact retries for this task (15 minutes)')
    await expect(leaseOption.$('.approval-turn-tree-input')).toBeChecked()

    await saveAppScreenshot('capability-lease-approval.png')
    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
