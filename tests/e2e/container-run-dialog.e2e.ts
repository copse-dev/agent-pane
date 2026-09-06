import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * The real renderer → preload → main path up to the point Docker would be
 * needed: the footer action opens the authorisation dialog quoting the composer
 * draft as the task, with the thread's model selected and changeable. The
 * refusal of a model without a key is unit-tested in
 * `container-run-service.test.ts`; the Docker path itself is the opt-in
 * integration test in `src/main/services/container-runtime/`.
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

  it('opens from the footer quoting the draft, with the model selectable', async () => {
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
    // The task is the composer draft, quoted rather than asked for again.
    const task = dialog.$('.container-run-prompt')
    await expect(task).toHaveValue('Clear the lint backlog and open a PR.')
    expect(await task.getAttribute('readonly')).not.toBe(null)
    // The model is a choice, not a label, and it defaults to the thread's. This
    // fixture seeds no provider keys, so the option list legitimately resolves
    // to just that model — the picker must stay usable rather than blank. The
    // populated list is covered in the browser tier, which has a provider.
    const model = dialog.$('.container-run-model')
    expect(await model.getTagName()).toBe('select')
    await expect(model).toHaveValue('claude-sonnet-4-6')
    expect(await model.$$('option').length).toBeGreaterThanOrEqual(1)
    expect(await dialog.$('.container-run-model-hint').getText()).toContain('scoped to the run')
    await expect(dialog.$('.container-run-minutes')).toHaveValue('120')
    await expect(dialog.$('.container-run-start')).toBeEnabled()
    await saveElementScreenshot('#container-run-dialog', 'container-run-dialog-electron.png')

    await dialog.$('.container-run-cancel').click()
    await expect(dialog).not.toBeDisplayed()
    await expect($('.container-run-banner')).not.toBeDisplayed()
  })
})
