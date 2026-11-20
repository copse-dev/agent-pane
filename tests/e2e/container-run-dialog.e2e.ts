import { findAsync } from './helpers/find-async.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

/**
 * The real renderer → preload → main path up to the point Docker would be
 * needed: the footer action opens the authorisation dialog quoting the composer
 * draft as the task, with the thread's model selected and changeable, and
 * GitHub reads off until the user turns them on for the run. The refusal of a
 * model without a key, and which runs get GitHub reads, are unit-tested in
 * `container-run-service.test.ts`; the Docker path itself is the opt-in
 * integration test in `src/main/services/container-runtime/`.
 */

const PROJECT_ID = 'e2e-container-run-project'
let workspaceRoot = ''

async function openDialog(): Promise<WebdriverIO.Element> {
  await $('.footer-overflow-trigger').click()
  const items = await $$('.footer-overflow-item').getElements()
  const item = await findAsync(items, async (candidate) =>
    (await candidate.getText()).includes('Run unattended in a container'),
  )
  if (!item) throw new Error('Container run footer action was not available')
  await item.click()
  const dialog = await $('#container-run-dialog').getElement()
  await dialog.waitForDisplayed({ timeout: 10_000 })
  return dialog
}

describe('unattended container run dialog', function () {
  this.timeout(120_000)
  before(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-container-run-'))
    resetUserData()
    seedEmptyProject(workspaceRoot, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      containerRunsEnabled: true,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) removeE2eTree(workspaceRoot)
  })

  it('opens from the footer quoting the draft, with the model selectable', async () => {
    await setComposerValue('Clear the lint backlog and open a PR.')
    const dialog = await openDialog()
    // The task is the composer draft, quoted rather than asked for again.
    const task = dialog.$('.container-run-prompt')
    await expect(task).toHaveValue('Clear the lint backlog and open a PR.')
    expect(await task.getAttribute('readonly')).not.toBe(null)
    // The model is the shared searchable picker, over a hidden native select
    // that carries the value, defaulting to the thread's model. This fixture
    // seeds no provider keys, so what matters is that it still names the
    // thread's model rather than going blank.
    await expect(dialog.$('.container-run-model')).toHaveValue('claude-sonnet-4-6')
    await expect(
      dialog.$('.model-picker-trigger[aria-label="Model for the unattended run"]'),
    ).toBeDisplayed()
    expect(await dialog.$('.container-run-model-hint').getText()).toContain(
      'provider keys and sign-in tokens stay on the desktop',
    )
    await expect(dialog.$('.container-run-minutes')).toHaveValue('120')
    await expect(dialog.$('.container-run-start')).toBeEnabled()
    await saveElementScreenshot('#container-run-dialog', 'container-run-dialog-electron.png')

    await dialog.$('.container-run-cancel').click()
    await expect(dialog).not.toBeDisplayed()
    await expect($('.container-run-banner')).not.toBeDisplayed()
  })

  it('offers GitHub reads per run, off by default, and quotes the arming line', async () => {
    const dialog = await openDialog()
    const github = dialog.$('.container-run-github')
    const install = dialog.$('.container-run-install')
    const arming = dialog.$('.container-run-github-arming')
    // Off until the user turns it on, and the line the run would record says so.
    await expect(github).not.toBeChecked()
    await expect(arming).toHaveText('GitHub: off, not turned on for this run')
    expect(await dialog.$('.container-run-github-hint').getText()).toContain(
      'secret-scanning alerts, Actions variables and secret gists',
    )
    // A fresh run installs by default, and an install keeps GitHub reads off.
    await expect(install).toBeChecked()
    await github.click()
    await expect(github).toBeChecked()
    await expect(arming).toHaveText('GitHub: off, because the run installs dependencies')
    // With no install, the thread's model, which the desktop calls, gets them.
    await install.click()
    await expect(install).not.toBeChecked()
    await expect(arming).toHaveText(
      'GitHub: read-only through your desktop GitHub sign-in, turned on for this run; writes refused',
    )
    await saveElementScreenshot(
      '#container-run-dialog .container-run-github-field',
      'container-run-github-reads-electron.png',
    )

    await dialog.$('.container-run-cancel').click()
    await expect(dialog).not.toBeDisplayed()
    await expect($('.container-run-banner')).not.toBeDisplayed()
  })
})
