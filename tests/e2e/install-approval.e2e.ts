import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('package install approval', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-install-approval-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      theme: 'light',
      uiAccentColor: '#20FD85',
      uiTintColor: '#244C25',
      uiTintStrength: 'subtle',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows a clean, install-specific approval dialog', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await setComposerValue('[[mcp:run_shell {"command":"npm install"}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Run package install?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toContain('npm install')
    expect(body).not.toContain('Socket Firewall')
    const advice = await dialog.$('.approval-advice').getText()
    expect(advice).toContain('Socket Firewall (sfw)')
    expect(advice).toContain('This installs packages')
    const footer = await dialog.$('.approval-footer').getText()
    expect(footer).toContain('Allow this install?')
    expect(body).not.toContain('Allow this install?')
    // The noisy generic external-reason text must not leak into the install prompt.
    expect(body).not.toContain('may fetch + run code from network')

    const primaryAppearance = await browser.execute(() => {
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
    expect(primaryAppearance).not.toBeNull()
    expect(primaryAppearance?.background).toBe('rgb(32, 253, 133)')
    expect(primaryAppearance?.color).toBe('rgb(68, 68, 68)')
    expect(primaryAppearance?.contrast ?? 0).toBeGreaterThanOrEqual(4.5)

    await saveAppScreenshot('install-approval-dialog.png')

    await dialog.$('.approval-reject').click()
  })
})
