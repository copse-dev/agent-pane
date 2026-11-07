import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('attachment picker keyboard scrolling', () => {
  before(async () => {
    resetUserData()
    const files: Record<string, string> = {}
    for (let i = 0; i < 25; i++) {
      files[`attachments/example-${String(i).padStart(2, '0')}.ts`] =
        'export const example = true\n'
    }
    seedEmptyProject(seedStableWorkspace({ files }), 'mention-scroll')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps the selected attachment visible down and up, then attaches it', async () => {
    await setComposerValue('@example-')
    await browser.waitUntil(async () => (await $$('.mention-picker .mention-item')).length >= 20, {
      timeout: 15_000,
    })

    for (let i = 0; i < 18; i++) await browser.keys('ArrowDown')
    const selectedPath = await $('.mention-item.selected').getText()
    const geometry = await browser.execute(() => {
      const picker = document.querySelector<HTMLElement>('.mention-picker')
      const selected = picker?.querySelector<HTMLElement>('.selected')
      if (!picker || !selected) throw new Error('Missing attachment selection')
      const outer = picker.getBoundingClientRect()
      const row = selected.getBoundingClientRect()
      return {
        scroll: picker.scrollTop,
        top: row.top - outer.top,
        bottom: row.bottom - outer.top,
        height: picker.clientHeight,
      }
    })
    assert.ok(geometry.scroll > 0, 'keyboard navigation must scroll the picker')
    assert.ok(
      geometry.top >= 0 && geometry.bottom <= geometry.height + 2,
      'selected row must be visible',
    )
    await saveAppScreenshot('mention-picker-scrolled.png')

    for (let i = 0; i < 18; i++) await browser.keys('ArrowUp')
    assert.equal(
      await browser.execute(() => document.querySelector('.mention-picker')?.scrollTop),
      0,
    )
    await saveAppScreenshot('mention-picker-top.png')

    for (let i = 0; i < 18; i++) await browser.keys('ArrowDown')
    await expect($('.mention-item.selected')).toHaveText(selectedPath)
    await browser.keys('Enter')
    await expect($('.attachment-chip-label')).toHaveText(
      selectedPath.split('/').pop() ?? selectedPath,
    )
    await expect($('.mention-picker')).not.toBeDisplayed()
  })
})
