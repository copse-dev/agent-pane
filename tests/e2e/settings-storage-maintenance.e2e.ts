import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { copseDataRoot, copseWorkspaceTmpDir } from '../../src/main/services/storage/copse-paths.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const run = join(copseDataRoot(), 'runtimes/run-abc-abcdef')
const build = join(copseWorkspaceTmpDir(), 'apple-development/storage-e2e')
const scratch = join(copseWorkspaceTmpDir(), 'storage-user-scratch.txt')

describe('Storage cleanup controls', function () {
  this.timeout(90_000)
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'storage-maintenance-e2e')
    mkdirSync(run, { recursive: true })
    writeFileSync(
      join(run, 'record.json'),
      JSON.stringify({ finishedAt: 1, teardown: 'removed', cleanupError: null }),
    )
    writeFileSync(join(run, 'carry-in.bundle'), 'repository snapshot')
    mkdirSync(build, { recursive: true })
    writeFileSync(join(build, 'cache'), 'build data')
    writeFileSync(scratch, 'keep this scratch')
    await browser.reloadSession()
  })
  after(() => {
    for (const path of [run, build, scratch]) rmSync(path, { recursive: true, force: true })
    resetUserData()
  })
  it('shows both areas, saves retention and cleans only the confirmed target', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="storage"]').click()
    const panel = await $('#storage-maintenance').getElement()
    await panel.scrollIntoView()
    const runs = await $('#storage-runs-clean').getElement()
    await expect(runs).toBeEnabled()
    await expect($('#storage-builds-clean')).toBeEnabled()
    await expect($('#storage-runs-size')).toHaveText(expect.stringContaining('1 item'))
    await expect($('#storage-expiry-enabled')).toBeChecked()
    await $('#storage-expiry-days').selectByAttribute('value', '90')
    await expect($('#storage-maintenance-status')).toHaveText('Automatic cleanup updated.')
    await saveElementScreenshot('#storage-maintenance', 'settings-storage-maintenance.png')
    await runs.click()
    await expect($('#confirm-dialog')).toBeDisplayed()
    assert.equal(existsSync(run), true)
    await saveElementScreenshot('#confirm-dialog', 'settings-storage-maintenance-confirm.png')
    await $('#confirm-dialog .confirm-dialog-confirm').click()
    await expect($('#storage-maintenance-status')).toHaveText(
      expect.stringContaining('Removed 1 item'),
    )
    assert.equal(existsSync(run), false)
    assert.equal(existsSync(build), true)
    await $('#storage-builds-clean').click()
    await $('#confirm-dialog .confirm-dialog-confirm').click()
    await expect($('#storage-builds-clean')).toBeDisabled()
    assert.equal(existsSync(build), false)
    assert.equal(readFileSync(scratch, 'utf8'), 'keep this scratch')
    await expect($('.toast-error')).not.toExist()
    await saveElementScreenshot('#storage-maintenance', 'settings-storage-maintenance-cleaned.png')
  })
})
