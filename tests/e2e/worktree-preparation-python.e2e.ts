import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { readWorktreePreparationPlan } from '../../src/main/services/worktree-preparation-plan.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const root = mkdtempSync(join(tmpdir(), 'python-preparation-approval-'))
describe('automatic Python preparation approval', () => {
  before(async () => {
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[project]\nname="ordinary-python-app"\nversion="0.1.0"\nrequires-python=">=3.11"\ndependencies=[]\n',
    )
    writeFileSync(join(root, 'uv.lock'), 'version = 1\nrevision = 3\n')
    resetUserData()
    seedEmptyProject(root, 'e2e-python-preparation', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    rmSync(root, { recursive: true, force: true })
  })
  it('shows the locked uv command and repository-code warning without a declaration', async () => {
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
    expect(body).toContain('uv')
    expect(body).toContain('--locked')
    expect(body).toContain('--all-packages')
    expect(body).toContain('--no-python-downloads')
    const advice = await dialog.$('.approval-advice').getText()
    expect(advice).toContain('executes repository code')
    expect(advice).not.toContain('lifecycle scripts disabled')
    expect(await dialog.$('.approval-footer').getText()).toContain('blocked for every subprocess')
    await saveElementScreenshot('#approval-dialog', 'worktree-preparation-python.png')
    await dialog.$('.approval-reject').click()
  })

  it('shows exact hash and wheel-only protections for automatic pip preparation', async () => {
    rmSync(join(root, 'uv.lock'))
    rmSync(join(root, 'pyproject.toml'))
    writeFileSync(
      join(root, 'requirements.lock'),
      `example-package==1.2.3 --hash=sha256:${'a'.repeat(64)}\n`,
    )
    const planFingerprint = readWorktreePreparationPlan(root).fingerprint
    await prepareMockToolTurn(
      'Prepare this hash-locked Python worktree.',
      { name: 'prepare_worktree', args: { planFingerprint, offline: true } },
      'The worktree preparation request was declined.',
    )
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('python3')
    expect(body).toContain('--require-hashes')
    expect(body).toContain('--only-binary=:all:')
    const advice = await dialog.$('.approval-advice').getText()
    expect(advice).toContain('exact SHA-256-locked wheels only')
    expect(advice).toContain('source builds and package build scripts are disabled')
    await saveElementScreenshot('#approval-dialog', 'worktree-preparation-pip.png')
    await dialog.$('.approval-reject').click()
  })
})
