import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted light approval accent', () => {
  before(async () => {
    await browser.url('/?scenario=approval-light-accent')
    await $('#approval-dialog').waitForDisplayed()
  })

  it('keeps a bright custom accent readable on the primary action', async () => {
    const dialog = $('#approval-dialog')
    await expect(dialog.$('.approval-heading')).toHaveText('Run outside sandbox?')
    await expect(dialog.$('.approval-approve')).toHaveText('Approve')
    await expect(dialog.$('.approval-reject')).toHaveText('Reject')

    const appearance = await browser.execute(() => {
      const button = document.querySelector<HTMLElement>('.approval-approve')
      if (!button) return null
      const style = getComputedStyle(button)
      const channels = (value: string): number[] => value.match(/[\d.]+/g)?.map(Number) ?? []
      const luminance = (rgb: number[]): number => {
        const linear = rgb.slice(0, 3).map((channel) => {
          const scaled = channel / 255
          return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
      }
      const background = style.backgroundColor
      const color = style.color
      const backgroundLuminance = luminance(channels(background))
      const colorLuminance = luminance(channels(color))
      return {
        background,
        color,
        contrast:
          (Math.max(backgroundLuminance, colorLuminance) + 0.05) /
          (Math.min(backgroundLuminance, colorLuminance) + 0.05),
      }
    })

    assert.ok(appearance, 'approval primary action must exist')
    assert.equal(appearance.background, 'rgb(32, 253, 133)')
    assert.equal(appearance.color, 'rgb(68, 68, 68)')
    assert.ok(appearance.contrast >= 4.5, `expected WCAG AA contrast, got ${appearance.contrast}`)

    await saveElementScreenshot('#approval-dialog', 'approval-light-accent.png')
  })
})
