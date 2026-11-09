import { $, browser, expect } from '@wdio/globals'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function choosePr(): Promise<void> {
  await $('.review-subject-picker').click()
  await $('.review-subject-choices .pr-list-row').waitForClickable()
  await $('.review-subject-choices .pr-list-row').click()
  await expect($('#pr-viewer-host .pr-viewer-title')).toHaveText('Keep search results in order')
  const error = await browser.execute(() => document.getElementById('fixture-error')?.textContent)
  if (error) throw new Error(error)
  await $('.pr-detail-section[data-section="files"]').waitForDisplayed()
}

describe('Unified local and GitHub review surface', () => {
  before(async () => {
    await build({
      entryPoints: ['tests/demo/helpers/unified-review-fixture.ts'],
      outfile: 'dist/demo/unified-review-fixture.js',
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      tsconfig: 'tsconfig.web.json',
    })
    await writeFile(
      'dist/demo/unified-review-fixture.html',
      '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/unified-review-fixture.js"></script></body></html>',
    )
  })

  beforeEach(async () => {
    await browser.url('/unified-review-fixture.html')
    await $('.review-subject-picker').waitForClickable()
    await $('.diff-accept-btn').waitForDisplayed()
  })

  it('switches subjects in one pane and retains local approvals and the PR section', async () => {
    await expect($('[data-panel-control="changes"]')).toHaveText(expect.stringContaining('Review'))
    await expect($('[data-panel-control="prs"]')).not.toExist()
    await expect($('.review-local-meta')).toHaveText(
      expect.stringContaining('Only on this machine'),
    )
    await saveElementScreenshot('#pane-files', 'unified-review-local.png')
    await choosePr()
    await expect($('#right-sidebar')).not.toBeDisplayed()
    await expect($('.review-subject-choices')).not.toBeDisplayed()
    await expect($('[data-panel-control="changes"]')).toHaveElementClass('active')
    await $('.pr-detail-section[data-section="comments"]').click()
    await expect($('.pr-activity')).toHaveText(
      expect.stringContaining('The request guard looks good.'),
    )
    await $('.pr-detail-section[data-section="checks"]').click()
    await expect($('.pr-activity')).toHaveText(expect.stringContaining('Unit tests'))
    await saveElementScreenshot('#pane-files', 'unified-review-pr.png')
    await $('.pr-detail-section[data-section="files"]').click()
    await $('.pr-file-row').click()
    await $('#pr-viewer-host .monaco-diff-editor').waitForDisplayed()
    await $('.review-subject-picker').click()
    await $('.review-local-choice').click()
    await expect($('.diff-accept-btn')).toBeDisplayed()
    await expect($('.git-change-row-proposed')).toHaveElementClass('is-selected')
    await choosePr()
    await expect($('.pr-file-row.is-selected')).toBeDisplayed()
    await expect($('#pr-viewer-host .monaco-diff-editor')).toBeDisplayed()
  })

  it('keeps the picker inside a narrow pane and dismisses it with Escape', async () => {
    await browser.execute(() => {
      const pane = document.getElementById('pane-files')
      if (pane) pane.style.width = '340px'
    })
    await $('.review-subject-picker').click()
    await expect($('.review-subject-choices')).toBeDisplayed()
    await expect($('.review-local-choice')).toHaveAttribute('aria-current', 'true')
    await expect($('.pr-list-row.is-selected')).not.toExist()
    const fits = await browser.execute(() => {
      const rect = document.querySelector('.review-subject-choices')?.getBoundingClientRect()
      const header = document.querySelector('.review-header')
      return (
        !!rect &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        !!header &&
        header.scrollWidth <= header.clientWidth
      )
    })
    expect(fits).toBe(true)
    await saveElementScreenshot('#pane-files', 'unified-review-narrow-picker.png')
    await browser.keys('Escape')
    await expect($('.review-subject-choices')).not.toBeDisplayed()
    await expect($('.review-subject-picker')).toBeFocused()
    await saveElementScreenshot('#pane-files', 'unified-review-narrow-local.png')
    await choosePr()
    await saveElementScreenshot('#pane-files', 'unified-review-narrow-pr.png')
  })

  it('keeps local review available when GitHub is signed out', async () => {
    await browser.url('/unified-review-fixture.html?offline')
    await $('.diff-accept-btn').waitForDisplayed()
    await $('.review-subject-picker').click()
    await expect($('.review-subject-choices')).toHaveText(expect.stringContaining('Sign in'))
    await $('.review-local-choice').click()
    await expect($('.diff-accept-btn')).toBeDisplayed()
  })
})
