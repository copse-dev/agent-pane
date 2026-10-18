import { createFixtureDirectory } from './helpers/fixture-directory.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { readWorktreePreparationPlan } from '../../src/main/services/worktree-preparation-plan.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'

const fixture = createFixtureDirectory('project-preparation-approval')
const { root } = fixture
describe('project preparation approval', () => {
  before(async () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, '.copse'))
    writeFileSync(join(root, 'package.json'), '{"packageManager":"npm@11.19.0"}')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    writeFileSync(
      join(root, '.copse/worktree-preparation.json'),
      JSON.stringify({
        version: 1,
        prepare: [{ command: 'python3', args: ['scripts/setup.py'] }],
        checks: [{ name: 'Generated files', path: 'generated' }],
      }),
    )
    resetUserData()
    seedEmptyProject(root, 'e2e-project-preparation-approval', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    fixture.cleanup()
  })
  it('names the actual install and declared setup before asking for approval', async () => {
    const planFingerprint = readWorktreePreparationPlan(root).fingerprint
    await prepareMockToolTurn(
      'Prepare this worktree using its locked dependencies.',
      { name: 'prepare_worktree', args: { planFingerprint, offline: true } },
      'The worktree preparation request was declined.',
    )
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Prepare this worktree?')
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('npm')
    expect(body).toContain('ci')
    expect(body).toContain('scripts/setup.py')
    expect(await dialog.$('.approval-advice').getText()).toContain('executes repository code')
    expect(await dialog.$('.approval-footer').getText()).toContain('blocked for every subprocess')
    expect(body).not.toContain(planFingerprint)
    expect(body).not.toContain('gortex')
    await expect(dialog.$('.approval-footer')).toHaveText(expect.stringContaining(root))
    // Assert the real permission scope before normalizing only its scratch path.
    const restorePath = await pinTextForCapture(
      '.approval-footer',
      /Project: [^\n]+/,
      'Project: /tmp/project-preparation-approval',
    )
    try {
      await saveAppScreenshot('worktree-preparation-approval.png')
    } finally {
      await restorePath()
    }
    await dialog.$('.approval-reject').click()
  })
})
