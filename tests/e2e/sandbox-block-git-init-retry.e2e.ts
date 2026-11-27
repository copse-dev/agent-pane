import { $, browser, expect } from '@wdio/globals'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { waitForAgentIdle } from './helpers.ts'
import { submitComposer } from './helpers/composer.ts'

const PROJECT_ID = 'e2e-sandbox-block-git-init'
// A folder that is not a repository yet: the project sandbox protects `.git`
// (it denies writes to `.git/hooks`), so `git init` cannot create it inside.
const ROOT = join(tmpdir(), 'copse-e2e', 'no-repository-workspace')

// Only the macOS seatbelt reports its denials (ASRT's log monitor), so only there
// can a contained command's block be verified. Linux CI has no monitor running.
const describeVerifiedBlock = process.platform === 'darwin' ? describe : describe.skip

describeVerifiedBlock('a sandbox block on git init', () => {
  before(async () => {
    resetUserData()
    removeE2eTree(ROOT)
    mkdirSync(ROOT, { recursive: true })
    writeFileSync(join(ROOT, 'README.md'), '# Not a repository yet\n')
    seedEmptyProject(ROOT, PROJECT_ID, { subagentsEnabled: false, model: 'claude-sonnet-4-6' })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    removeE2eTree(ROOT)
  })

  it('verifies the block and runs git init outside once the user approves', async () => {
    // No `expects_sandbox_block`: the command is contained, so only a block the
    // OS sandbox itself reported may offer the outside retry.
    const scenario = await prepareMockToolTurn(
      'Initialise this folder as a git repository.',
      { name: 'run_shell', args: { command: 'git init' } },
      'The folder is now a git repository.',
    )
    await submitComposer()

    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Run outside sandbox?')
    expect(await dialog.$('.approval-body').getText()).toBe('git init')
    await expect(dialog.$('.approval-advice')).toHaveText(
      expect.stringContaining(
        'This command failed inside the project sandbox (the OS sandbox blocked',
      ),
    )
    expect(existsSync(join(ROOT, '.git'))).toBe(false)
    await saveElementScreenshot('#approval-dialog', 'sandbox-block-git-init-retry.png')

    await dialog.$('.approval-approve').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The folder is now a git repository.')
    expect(existsSync(join(ROOT, '.git', 'HEAD'))).toBe(true)
    await scenario.assertComplete()
  })
})
