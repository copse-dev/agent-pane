import { $, $$, browser, expect } from '@wdio/globals'
import { prepareE2eScreenshot, saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function openPrototype(): Promise<void> {
  await browser.setWindowSize(1280, 860)
  await browser.url('/prototypes/edit-thread.html')
  await $('#fork').waitForDisplayed()
  if ((await $('html').getAttribute('data-theme')) === 'light') await $('#theme').click()
}

async function openHistoryEditor(): Promise<void> {
  await $('#fork').click()
  await expect($('#edit-history')).toBeDisplayed()
  await $('#edit-history').click()
}

async function noOverflow(): Promise<void> {
  const measurements = await browser.execute(() => {
    return ['html', '#app', '.conversation', '.edit-footer'].map((selector) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error('Missing ' + selector)
      return element.scrollWidth - element.clientWidth
    })
  })
  for (const overflow of measurements) expect(overflow).toBeLessThanOrEqual(1)
}

describe('edit thread prototype', () => {
  beforeEach(openPrototype)

  it('enters through Fork, reviews a sample cleanup, applies it, and restores the original', async () => {
    expect(await $$('.message').length).toBe(6)
    await expect($('#edit-history')).not.toExist()
    expect(await $$('[data-edit]').length).toBe(0)
    await saveElementScreenshot('#app', 'edit-thread-original.png')
    await $('#fork').click()
    await saveElementScreenshot('#app', 'edit-thread-fork-menu.png')
    await browser.keys('Escape')
    await openHistoryEditor()
    await expect($('#review')).toBeDisabled()
    await $('#sample').click()
    await expect($('#draft-indicator')).toHaveText('1 edited · 3 excluded')
    await expect($('#result-count')).toHaveText('3')
    await expect($('[data-text="1"]')).toBeDisabled()
    await $('#review').click()
    await expect($('#thread-eyebrow')).toHaveText('Edit thread · 2 of 2 · Review')
    await expect($('[data-text="0"]')).toHaveAttribute('readonly')
    expect(await $$('.preview-message').length).toBe(3)
    await expect($('#history-preview')).not.toHaveText(expect.stringContaining('Fuse.js'))
    await noOverflow()
    await saveElementScreenshot('#app', 'edit-thread-review-dark.png')
    await $('#review').click()
    expect(await $$('.message').length).toBe(3)
    await expect($('#messages')).not.toHaveText(expect.stringContaining('Fuse.js'))
    await expect($('#revision-banner')).toBeDisplayed()
    await saveElementScreenshot('#app', 'edit-thread-applied.png')
    await $('#undo').click()
    expect(await $$('.message').length).toBe(6)
    await expect($('#messages')).toHaveText(expect.stringContaining('Fuse.js'))
    await expect($('#revision-banner')).not.toBeDisplayed()
  })

  it('supports arbitrary text edits, cancellation, and invalid empty histories', async () => {
    await openHistoryEditor()
    await $('[data-text="0"]').setValue(
      'Search command descriptions only. Keep <script>literal text</script>.',
    )
    await expect($('#draft-indicator')).toHaveText('1 edited · 0 excluded')
    await $('#cancel').click()
    await expect($('#discard-dialog')).toBeDisplayed()
    await $('#keep-editing').click()
    await expect($('[data-text="0"]')).toHaveValue(expect.stringContaining('descriptions only'))
    await $('[data-text="0"]').setValue('')
    await expect($('#review')).toBeDisabled()
    await expect($('#error-note')).toHaveText(expect.stringContaining('need some text'))
    for (let index = 0; index < 6; index++) await $('[data-include="' + index + '"]').click()
    await expect($('#result-count')).toHaveText('0')
    await expect($('#review')).toBeDisabled()
    await expect($('#error-note')).toHaveText(expect.stringContaining('at least one'))
    await $('#cancel').click()
    await $('#discard').click()
    await expect($('#messages')).toHaveText(expect.stringContaining('Add fuzzy search'))
    await $('[data-fork="0"]').click()
    await $('#edit-history').click()
    await $('[data-text="0"]').setValue(
      'Search descriptions only. Keep <script>literal text</script>.',
    )
    await $('#review').click()
    await $('#review').click()
    await expect($('.message-body')).toHaveText(
      'Search descriptions only. Keep <script>literal text</script>.',
    )
    expect(await $$('#messages script').length).toBe(0)
  })

  it('forks the selected transcript into a separate mock thread', async () => {
    await $('[data-fork="0"]').click()
    await $('#fork-copy').click()
    expect(await $$('.message').length).toBe(1)
    expect(await $$('#thread-nav [data-thread]').length).toBe(2)
    await $('[data-thread="1"]').click()
    expect(await $$('.message').length).toBe(6)
    await $('#fork').click()
    await $('#fork-copy').click()
    expect(await $$('.message').length).toBe(6)
    expect(await $$('#thread-nav [data-thread]').length).toBe(3)
  })

  it('supports light mode and a narrow edit-review-apply flow', async () => {
    if ((await $('html').getAttribute('data-theme')) === 'dark') await $('#theme').click()
    await openHistoryEditor()
    await $('#sample').click()
    await $('#review').click()
    await saveElementScreenshot('#app', 'edit-thread-review-light.png')
    await $('#cancel').click()
    await browser.setWindowSize(390, 844)
    await prepareE2eScreenshot()
    await noOverflow()
    await $('#review').click()
    await expect($('#history-preview')).toBeDisplayed()
    await expect($('#review')).toBeDisplayed()
    await noOverflow()
    await saveElementScreenshot('#app', 'edit-thread-review-narrow.png')
    await $('#review').click()
    expect(await $$('.message').length).toBe(3)
    await $('#compose-text').setValue('Continue with the current search requirements.')
    await $('#send').click()
    expect(await $$('.message').length).toBe(5)
    await expect($('#messages')).toHaveText(expect.stringContaining('cleaned-up requirements'))
    await noOverflow()
  })
})
