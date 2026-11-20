import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { readWorktreePreparationPlan } from '../../src/main/services/worktree-preparation-plan.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { submitComposer } from './helpers/composer.ts'

const root = join(tmpdir(), 'copse-e2e', 'python-preparation-approval')
describe('automatic Python preparation approval', () => {
  before(async () => {
    removeE2eTree(root)
    mkdirSync(root, { recursive: true })
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
    removeE2eTree(root)
  })
  it('shows the locked uv command and repository-code warning without a declaration', async () => {
    const planFingerprint = readWorktreePreparationPlan(root).fingerprint
    await prepareMockToolTurn(
      'Prepare this worktree using its locked dependencies.',
      { name: 'prepare_worktree', args: { planFingerprint, offline: true } },
      'The worktree preparation request was declined.',
    )
    await submitComposer()
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
    await submitComposer()
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

  it('shows an explicit installed-uv requirements plan with its exact project interpreter', async () => {
    mkdirSync(join(root, '.copse'), { recursive: true })
    writeFileSync(
      join(root, '.copse/worktree-preparation.json'),
      JSON.stringify({
        version: 1,
        inputs: ['requirements.lock', '.python-version', 'vendor'],
        prepare: [
          { command: 'python3.9', args: ['-m', 'venv', '--without-pip', '.venv'] },
          {
            command: 'uv',
            args: [
              'pip',
              'sync',
              '--python',
              '.venv/bin/python',
              '--no-python-downloads',
              '--require-hashes',
              '--only-binary=:all:',
              '--no-index',
              '--find-links',
              'vendor',
              'requirements.lock',
            ],
          },
        ],
        checks: [
          {
            name: 'Locked uv requirements',
            command: {
              command: 'uv',
              args: [
                'pip',
                'sync',
                '--check',
                '--offline',
                '--no-cache',
                '--python',
                '.venv/bin/python',
                '--no-python-downloads',
                '--require-hashes',
                '--only-binary=:all:',
                '--no-index',
                '--find-links',
                'vendor',
                'requirements.lock',
              ],
            },
          },
        ],
      }),
    )
    const planFingerprint = readWorktreePreparationPlan(root).fingerprint
    await prepareMockToolTurn(
      'Review this explicit Python 3.9 requirements setup.',
      { name: 'prepare_worktree', args: { planFingerprint, offline: true } },
      'The worktree preparation request was declined.',
    )
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('python3.9')
    expect(body).toContain('--without-pip')
    expect(body).toContain('uv')
    expect(body).toContain('--python')
    expect(body).toContain('.venv/bin/python')
    expect(body).toContain('--no-python-downloads')
    expect(body).toContain('--require-hashes')
    expect(body).toContain('--only-binary=:all:')
    expect(body).toContain('--no-index')
    expect(await dialog.$('.approval-advice').getText()).toContain('executes repository code')
    expect(await dialog.$('.approval-footer').getText()).toContain('blocked for every subprocess')
    await saveElementScreenshot('#approval-dialog', 'worktree-preparation-uv-requirements.png')
    await dialog.$('.approval-reject').click()
  })
})
