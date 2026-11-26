import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { waitForAgentIdle } from './helpers.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT_ID = 'e2e-workspace-trust-offer'

// An untrusted project asks before commands the auto-approval tiers would run
// on their own in a trusted one. The prompt says that is why it is asking and
// offers to trust the project, behind its own confirmation, without answering
// the prompt. The push is rejected, so nothing leaves the machine.
describe('workspace trust offer on a shell prompt', () => {
  let root = ''

  before(async function () {
    this.timeout(60_000)
    root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-e2e-trust-offer-')))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Copse Test')
    git('config', 'user.email', 'copse@example.invalid')
    git('config', 'commit.gpgSign', 'false')
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'initial')
    git('remote', 'add', 'origin', 'https://example.invalid/trust-offer.git')
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(root, PROJECT_ID, { subagentsEnabled: false, model: 'claude-sonnet-4-6' })
    writeSettings({
      ...readSeededSettings(),
      shellAutoApprovalLevel: 'remote-write',
      autoRunSandboxCommands: true,
      safetyClassifierEnabled: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    assert.equal(await browser.execute(() => window.api.workspace.isTrusted()), false)
  })

  after(() => {
    resetUserData()
    if (root) removeE2eTree(root)
  })

  it('names missing trust as the reason and trusts only after confirming', async function () {
    this.timeout(90_000)
    await prepareMockToolTurn(
      'Push the branch.',
      { name: 'run_shell', args: { command: 'git push origin main' } },
      'The push was declined.',
    )
    await $('.submit-btn').click()

    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    const offer = dialog.$('.approval-trust-offer')
    await expect(offer).toBeDisplayed()
    await expect(offer).toHaveText(expect.stringContaining("this project isn't trusted"))
    await saveAppScreenshot('workspace-trust-offer-prompt.png')

    await offer.$('.approval-trust-offer-btn').click()
    const confirm = $('#confirm-dialog')
    await confirm.waitForDisplayed({ timeout: 10_000 })
    await expect(confirm.$('.confirm-dialog-message')).toHaveText(`Trust “${basename(root)}”?`)
    await expect(confirm.$('.confirm-dialog-detail')).toHaveText(
      expect.stringContaining('run without asking'),
    )
    await saveAppScreenshot('workspace-trust-offer-confirm.png')
    await confirm.$('.confirm-dialog-confirm').click()

    await expect(offer).toHaveText(expect.stringContaining('Project trusted'))
    await expect(offer.$('.approval-trust-offer-btn')).not.toBeDisplayed()
    // Trusting is not an answer: the command still waits for the user.
    await expect(dialog).toBeDisplayed()
    assert.equal(await browser.execute(() => window.api.workspace.isTrusted()), true)
    await saveAppScreenshot('workspace-trust-offer-trusted.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle()
  })
})
