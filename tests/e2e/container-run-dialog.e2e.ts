import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * The real renderer → preload → main path up to the point Docker would be
 * needed: the footer action opens the arming dialog with the composer draft
 * prefilled and the thread's model named. The refusal of a model without a key
 * is unit-tested in `container-run-service.test.ts`; the Docker path itself is
 * the opt-in integration test in `src/main/services/container-runtime/`.
 */

const PROJECT_ID = 'e2e-container-run-project'
let workspaceRoot = ''

describe('unattended container run dialog', function () {
  this.timeout(120_000)
  before(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-container-run-'))
    resetUserData()
    seedEmptyProject(workspaceRoot, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('opens from the footer with the draft prefilled and the model named', async () => {
    await setComposerValue('Clear the lint backlog and open a PR.')
    await $('.footer-overflow-trigger').click()
    const items = await $$('.footer-overflow-item')
    const item = await items.find(async (candidate) =>
      (await candidate.getText()).includes('Run unattended in a container'),
    )
    if (!item) throw new Error('Container run footer action was not available')
    await item.click()

    const dialog = await $('#container-run-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })
    await expect(dialog.$('.container-run-prompt')).toHaveValue(
      'Clear the lint backlog and open a PR.',
    )
    expect(await dialog.$('.container-run-model-hint').getText()).toContain(
      'Model: claude-sonnet-4-6',
    )
    await expect(dialog.$('.container-run-minutes')).toHaveValue('120')
    await expect(dialog.$('.container-run-start')).toBeDisplayed()
    await saveElementScreenshot('#container-run-dialog', 'container-run-dialog-electron.png')

    await dialog.$('.container-run-cancel').click()
    await expect(dialog).not.toBeDisplayed()
    await expect($('.container-run-banner')).not.toBeDisplayed()
  })
})
