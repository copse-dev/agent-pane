import { createFixtureDirectory } from './helpers/fixture-directory.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { readWorktreePreparationPlan } from '../../src/main/services/worktree-preparation-plan.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { pinTextForCapture, saveElementScreenshot } from './helpers/screenshot.ts'

const fixture = createFixtureDirectory('cargo-preparation-approval')
const { root } = fixture
describe('automatic Cargo preparation approval', () => {
  before(async () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'src'))
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[package]\nname="ordinary-rust-app"\nversion="0.1.0"\nedition="2021"\n',
    )
    writeFileSync(
      join(root, 'Cargo.lock'),
      'version = 4\n\n[[package]]\nname = "ordinary-rust-app"\nversion = "0.1.0"\n',
    )
    writeFileSync(join(root, 'src/main.rs'), 'fn main() {}\n')
    resetUserData()
    seedEmptyProject(root, 'e2e-cargo-preparation', {
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
  it('shows the fetch-only Cargo boundary without claiming compilation or execution', async () => {
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
    expect(body).toContain('Fetch locked Cargo dependencies')
    expect(body).toContain('cargo')
    expect(body).toContain('fetch')
    expect(body).toContain('--locked')
    const advice = await dialog.$('.approval-advice').getText()
    expect(advice).toContain('dependency sources only')
    expect(advice).toContain('does not compile crates or run build scripts, tests, or binaries')
    const footer = await dialog.$('.approval-footer').getText()
    expect(footer).toContain('project remains read-only')
    expect(footer).toContain('blocked for every subprocess')
    await expect(dialog.$('.approval-footer')).toHaveText(expect.stringContaining(root))
    // Assert the real permission scope before normalizing only its scratch path.
    const restorePath = await pinTextForCapture(
      '.approval-footer',
      /Project: [^\n]+/,
      'Project: /tmp/cargo-preparation-approval',
    )
    try {
      await saveElementScreenshot('#approval-dialog', 'worktree-preparation-cargo.png')
    } finally {
      await restorePath()
    }
    await dialog.$('.approval-reject').click()
  })
})
