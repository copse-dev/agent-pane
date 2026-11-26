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
    // The visible subject is the picker's accessible name (WCAG 2.5.3).
    await expect($('.review-subject-picker')).toHaveComputedLabel('Local changes')
    await expect($('.review-local-meta')).toHaveText(
      expect.stringContaining('Only on this machine'),
    )
    await saveElementScreenshot('#pane-files', 'unified-review-local.png')
    await choosePr()
    await expect($('.review-subject-picker')).toHaveComputedLabel('Pull request')
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
    // Opening on a PR focuses that PR, not the first choice.
    await expect($('.review-subject-choices .pr-list-row.is-selected')).toBeFocused()
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
    await expect($('.review-local-choice')).toBeFocused()
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
    // The app arms Escape-to-stop from a document keydown listener; a dismiss must not reach it.
    await browser.execute(() => {
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') document.body.dataset['escapeReachedDocument'] = 'true'
      })
    })
    await browser.keys('Escape')
    await expect($('.review-subject-choices')).not.toBeDisplayed()
    await expect($('.review-subject-picker')).toBeFocused()
    expect(
      await browser.execute(() => document.body.dataset['escapeReachedDocument'] ?? 'false'),
    ).toBe('false')
    await saveElementScreenshot('#pane-files', 'unified-review-narrow-local.png')
    await choosePr()
    await saveElementScreenshot('#pane-files', 'unified-review-narrow-pr.png')
  })

  it('closes the picker from its own button', async () => {
    const picker = $('.review-subject-picker')
    await picker.click()
    await expect($('.review-subject-choices')).toBeDisplayed()
    await expect(picker).toHaveAttribute('aria-expanded', 'true')
    await picker.click()
    await expect($('.review-subject-choices')).not.toBeDisplayed()
    await expect(picker).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the file list beside the diff at the default pane width', async () => {
    const layoutAt = async (width: number): Promise<string> =>
      browser.execute((px) => {
        const pane = document.getElementById('pane-files')
        if (pane) pane.style.width = `${String(px)}px`
        const body = pane?.querySelector('.pane-files-body')
        return body ? getComputedStyle(body).flexDirection : 'missing'
      }, width)
    expect(await layoutAt(480)).toBe('row')
    await expect($('#resizer-tree')).toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'unified-review-default-width.png')
    expect(await layoutAt(420)).toBe('column')
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
