import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { setComposerValue } from '../e2e/helpers/composer.ts'

describe('browser-hosted inline thread reference geometry', () => {
  before(async () => {
    await browser.url('/?scenario=inline-thread-reference')
    await $('.prompt-input').waitForExist()
    await setComposerValue('From @typesafe')
    const item = await $('.mention-picker .mention-item-thread')
    await item.waitForDisplayed()
    await item.click()
    await browser.keys(' can you compare this?')
  })

  it('uses the transcript outline without shifting or losing the text baseline', async () => {
    const chip = await $('.prompt-input .inline-thread-chip')
    await expect(chip).toHaveText(expect.stringContaining('TypeSafe inference'))
    await expect(chip.$('svg.thread-chip-icon[data-icon="thread"]')).toBeExisting()
    await expect(chip.$('svg[data-icon="close"]')).toBeExisting()
    await expect($('.attachment-chips .thread-chip')).not.toBeExisting()

    const metrics = await browser.execute(() => {
      const composerChip = document.querySelector<HTMLElement>('.inline-thread-chip')
      const transcriptChip = document.querySelector<HTMLElement>('.transcript-attachment-thread')
      const label = composerChip?.querySelector<HTMLElement>('.inline-thread-chip-label')
      const threadIcon = composerChip?.querySelector<SVGElement>('svg[data-icon="thread"]')
      const closeIcon = composerChip?.querySelector<SVGElement>('svg[data-icon="close"]')
      const precedingText = composerChip?.previousSibling
      if (
        !composerChip ||
        !transcriptChip ||
        !label ||
        !threadIcon ||
        !closeIcon ||
        !precedingText
      ) {
        return null
      }

      const textRange = document.createRange()
      textRange.selectNodeContents(precedingText)
      const labelRange = document.createRange()
      labelRange.selectNodeContents(label)
      const labelRect = label.getBoundingClientRect()
      const threadRect = threadIcon.getBoundingClientRect()
      const closeRect = closeIcon.getBoundingClientRect()
      const outline = (element: HTMLElement) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          borderTopColor: style.borderTopColor,
          borderTopStyle: style.borderTopStyle,
          borderTopWidth: style.borderTopWidth,
          fontSize: style.fontSize,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          paddingTop: style.paddingTop,
        }
      }
      return {
        textBottom: textRange.getBoundingClientRect().bottom,
        labelBottom: labelRange.getBoundingClientRect().bottom,
        labelCenter: labelRect.top + labelRect.height / 2,
        threadCenter: threadRect.top + threadRect.height / 2,
        closeCenter: closeRect.top + closeRect.height / 2,
        composerOutline: outline(composerChip),
        transcriptOutline: outline(transcriptChip),
      }
    })

    assert.ok(metrics, 'expected measurable inline thread-chip geometry')
    assert.deepEqual(
      metrics.composerOutline,
      metrics.transcriptOutline,
      'the composer and transcript thread chips share their outline tokens',
    )
    assert.ok(
      Math.abs(metrics.textBottom - metrics.labelBottom) <= 2,
      'the thread label shares the surrounding sentence baseline',
    )
    assert.ok(
      Math.abs(metrics.threadCenter - metrics.labelCenter) <= 1,
      'the thread icon is centered with the label',
    )
    assert.ok(
      Math.abs(metrics.closeCenter - metrics.labelCenter) <= 1,
      'the close icon is centered with the label',
    )

    const readChipRect = async () =>
      browser.execute(() => {
        const rect = document.querySelector('.inline-thread-chip')?.getBoundingClientRect()
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
      })
    const beforeHover = await readChipRect()
    assert.ok(beforeHover)
    await chip.moveTo()
    await browser.pause(100)
    const afterHover = await readChipRect()
    assert.ok(afterHover)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      assert.ok(
        Math.abs(beforeHover[key] - afterHover[key]) <= 0.25,
        `hover must not change the chip's ${key}`,
      )
    }

    await saveAppScreenshot('thread-reference-inline-composer.png')
  })
})
