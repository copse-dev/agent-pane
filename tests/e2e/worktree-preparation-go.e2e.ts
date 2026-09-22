import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { readWorktreePreparationPlan } from '../../src/main/services/worktree-preparation-plan.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const root = mkdtempSync(join(tmpdir(), 'go-preparation-approval-'))
describe('automatic Go preparation approval', () => {
  before(async () => {
    writeFileSync(join(root, 'go.mod'), 'module example.test/ordinary\n\ngo 1.24\n')
    writeFileSync(join(root, 'main.go'), 'package main\nfunc main() {}\n')
    resetUserData()
    seedEmptyProject(root, 'e2e-go-preparation', {
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
  it('shows the readonly Go package-loading boundary without claiming build success', async () => {
    const planFingerprint = readWorktreePreparationPlan(root).fingerprint
    await setComposerValue(
      `[[mcp:prepare_worktree ${JSON.stringify({ planFingerprint, offline: true })}]]`,
    )
    await $('.submit-btn').click()
    const dialog = $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Prepare this worktree?')
    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('Load locked Go package metadata')
    expect(body).toContain('go')
    expect(body).toContain('list')
    expect(body).toContain('-mod=readonly')
    expect(body).toContain('-deps')
    expect(body).toContain('-test')
    const advice = await dialog.$('.approval-advice').getText()
    expect(advice).toContain('package and test import metadata')
    expect(advice).toContain('does not run go generate, build, or test')
    const footer = await dialog.$('.approval-footer').getText()
    expect(footer).toContain('project remains read-only')
    expect(footer).toContain('blocked for every subprocess')
    await saveElementScreenshot('#approval-dialog', 'worktree-preparation-go.png')
    await dialog.$('.approval-reject').click()
  })
})
