import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('shared Apple and Android Run app picker', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/app-run-fixture.ts'],
      outfile: 'dist/demo/app-run-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/app-run-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/app-run-fixture.js"></script></body></html>',
    )
  })
  for (const platform of ['apple', 'android'])
    it(`shows ${platform} app and stopped device without enrollment`, async () => {
      await browser.url(`/app-run-fixture.html?mode=${platform}`)
      await $('.app-run-run').waitForEnabled()
      await expect($('.app-run-app')).toHaveValue('sample-app')
      await expect($('.app-run-device')).toHaveValue('phone')
      await expect($('.app-run-device option')).toHaveText(expect.stringContaining('Stopped'))
      await expect($('.app-run-more')).not.toHaveAttribute('open')
      await saveElementScreenshot('#app-run-dialog', `app-run-${platform}-picker.png`)
    })
  it('shows actual operation stage/logs and cancellation', async () => {
    await browser.url('/app-run-fixture.html?mode=android')
    await $('.app-run-run').waitForEnabled()
    await $('.app-run-run').click()
    await expect($('.app-run-stage')).toHaveText('Building')
    await $('.app-run-logs summary').click()
    await expect($('.app-run-log')).toHaveText(expect.stringContaining('compileDebugKotlin'))
    await expect($('.app-run-run')).toBeDisabled()
    await saveElementScreenshot('#app-run-dialog', 'app-run-progress.png')
    await $('.app-run-cancel').click()
    await expect($('.app-run-stage')).toHaveText('Cancelled')
  })
  it('shows missing setup and separates image download from device creation', async () => {
    await browser.url('/app-run-fixture.html?mode=setup')
    await expect($('.app-run-notice')).toHaveText('Create a device to run this app.')
    await expect($('.app-run-run')).toBeDisabled()
    await $('.app-run-create').click()
    await expect($('.app-run-setup-apply')).toHaveText('Create device')
    await $('[aria-label="Device runtime"]').selectByAttribute('value', 'android-36')
    await expect($('.app-run-setup-apply')).toHaveText('Download selected image')
    const visible = await browser.execute(() => {
      const dialog = document.querySelector('#app-run-dialog')?.getBoundingClientRect()
      const apply = document.querySelector('.app-run-setup-apply')?.getBoundingClientRect()
      return !!dialog && !!apply && apply.bottom <= dialog.bottom && apply.top >= dialog.top
    })
    expect(visible).toBe(true)
    await saveElementScreenshot('#app-run-dialog', 'app-run-setup.png')
  })
})
