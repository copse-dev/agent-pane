import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function open(context: string): Promise<void> {
  await browser.url(`/prototypes/default-announcement/index.html?context=${context}`)
  await $('#announcement').waitForDisplayed()
  await browser.execute(async () => {
    await document.fonts.ready
  })
}

async function assertFits(): Promise<void> {
  const geometry = await browser.execute(() => {
    const dialog = document.querySelector('#announcement')
    if (!dialog) throw new Error('Missing announcement')
    const rect = dialog.getBoundingClientRect()
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: innerWidth,
      height: innerHeight,
      overflow: dialog.scrollWidth - dialog.clientWidth,
    }
  })
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width)
  assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height)
  assert.ok(geometry.overflow <= 1)
}

describe('default change announcement prototype', () => {
  it('announces Compact for updates with a focused dismissal action', async () => {
    await open('update')
    await expect($('#announcement-title')).toHaveText('Compact is now the default')
    await expect($('#announcement-copy')).toHaveText(expect.stringContaining('out of experimental'))
    assert.equal(await browser.execute(() => document.activeElement?.id), 'acknowledge')
    await assertFits()
    await saveElementScreenshot('#announcement', 'default-announcement-dark.png')
    await $('#acknowledge').click()
    await expect($('#announcement')).not.toBeDisplayed()
    await expect($('#preview-status')).toHaveText('Preview: after update')
  })

  it('uses the same announcement for fresh installs and opens appearance settings', async () => {
    await open('fresh')
    await expect($('#preview-status')).toHaveText('Preview: fresh install')
    await $('#appearance').click()
    await expect($('#announcement')).not.toBeDisplayed()
    await expect($('#appearance-dialog')).toBeDisplayed()
    await expect($('input[value="compact"]')).toBeSelected()
    await $('input[value="expanded"]').click()
    await expect($('input[value="expanded"]')).toBeSelected()
    await $('#done').click()
    await $('#fresh').click()
    await expect($('#announcement')).toBeDisplayed()
    await browser.keys('Escape')
    await expect($('#announcement')).not.toBeDisplayed()
  })

  it('keeps the actions visible in light theme and a narrow pane', async () => {
    await $('#theme').click()
    await $('#update').click()
    await assertFits()
    await saveElementScreenshot('#announcement', 'default-announcement-light.png')
    await $('#acknowledge').click()
    await browser.setWindowSize(390, 740)
    // Desktop Chrome may enforce a wider minimum window. Pin the dialog to
    // a 390px pane's available width so the narrow layout is always exercised.
    await browser.execute(() => {
      const dialog = document.querySelector('#announcement')
      if (!(dialog instanceof HTMLDialogElement)) throw new Error('Missing announcement')
      dialog.style.width = '358px'
    })
    await $('#update').click()
    await assertFits()
    await expect($('#appearance')).toBeDisplayed()
    await expect($('#acknowledge')).toBeDisplayed()
    await saveElementScreenshot('#announcement', 'default-announcement-narrow.png')
  })
})
