import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('early Create PR description confirmation', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/create-pr-wait-fixture.ts'],
      outfile: 'dist/demo/create-pr-wait-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/create-pr-wait-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/create-pr-wait-fixture.js"></script></body></html>',
    )
  })

  it('shows bounded dialog geometry while waiting and returns the original generated body', async () => {
    await browser.url('/create-pr-wait-fixture.html')
    const dialog = $('#create-pr-dialog')
    await dialog.waitForDisplayed()
    await $('.create-pr-dialog-create').click()
    await expect($('.create-pr-dialog-create')).toHaveText('Waiting for description…')
    for (const selector of [
      '#create-pr-dialog-title',
      '#create-pr-dialog-body',
      '.create-pr-dialog-draft-input',
      '.create-pr-dialog-create',
    ]) {
      await expect($(selector)).toBeDisabled()
    }
    await expect($('.create-pr-dialog-cancel')).toBeEnabled()
    const fits = await browser.execute(() => {
      const dialog = document.querySelector('#create-pr-dialog')
      if (!dialog) return false
      const rect = dialog.getBoundingClientRect()
      return (
        dialog.scrollWidth <= dialog.clientWidth &&
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight
      )
    })
    expect(fits).toBe(true)
    await saveElementScreenshot('#create-pr-dialog', 'create-pr-description-wait.png')
    await browser.execute(() => document.dispatchEvent(new Event('release-description')))
    await expect(dialog).not.toBeDisplayed()
    await expect($('#fixture-result')).toHaveAttribute('data-status', 'confirmed')
    await expect($('#fixture-result')).toHaveAttribute(
      'data-body',
      'Generated description kept after confirmation.',
    )
  })

  it('keeps Cancel usable during waiting and ignores the later generated body', async () => {
    await browser.url('/create-pr-wait-fixture.html')
    await $('#create-pr-dialog').waitForDisplayed()
    await $('.create-pr-dialog-create').click()
    await $('.create-pr-dialog-cancel').click()
    await expect($('#fixture-result')).toHaveAttribute('data-status', 'cancelled')
    await browser.execute(() => document.dispatchEvent(new Event('release-description')))
    await expect($('#create-pr-dialog')).not.toBeDisplayed()
    await expect($('#fixture-result')).toHaveAttribute('data-status', 'cancelled')
    await expect($('#fixture-result')).not.toHaveAttribute('data-body')
  })
})
