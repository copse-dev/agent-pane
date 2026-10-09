import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { E2E_SCREENSHOT_DIR } from '../e2e/helpers/screenshot.ts'

async function screenshot(name: string): Promise<void> {
  expect(
    await browser.execute(() => document.documentElement.scrollWidth > window.innerWidth),
  ).toBe(false)
  await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, name))
}

async function expectComposerVisible(id: 'message' | 'new-message'): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((inputId) => {
        const input = document.getElementById(inputId)
        const button = input?.closest('form')?.querySelector('button[type="submit"]')
        const header = document.querySelector('.topbar')
        if (!input || !button || !header || document.activeElement !== input) return false
        const top = window.visualViewport?.offsetTop ?? 0
        const bottom = top + (window.visualViewport?.height ?? window.innerHeight)
        const headerRect = header.getBoundingClientRect()
        return (
          headerRect.top >= top - 1 &&
          headerRect.bottom <= bottom &&
          input.getBoundingClientRect().top >= headerRect.bottom &&
          button.getBoundingClientRect().bottom <= bottom
        )
      }, id),
    { timeoutMsg: 'Focused composer, submission button, and header must fit in the viewport' },
  )
}

describe('Mobile Companion at phone width', () => {
  it('uses desktop foundations for readable pairing, activity, and output in both themes', async () => {
    await browser.setWindowSize(390, 844)
    await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await browser.url('/mobile/')
    expect(await browser.execute(() => window.innerWidth)).toBe(390)

    for (const theme of ['dark', 'light']) {
      // Exercise a live OS-theme change as well as the fresh page's startup.
      await browser.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      })
      await expect($('html')).toHaveAttribute('data-theme', theme)
      await browser.execute(async () => {
        await fetch('/mobile-fixture/reset')
        localStorage.removeItem('copse-mobile-token')
        history.replaceState({ mobileView: 'activity' }, '')
      })
      await browser.refresh()
      await expect($('html')).toHaveAttribute('data-theme', theme)
      await expect($('#pair h1')).toHaveText('See what needs you.')

      const appearance = await browser.execute(async () => {
        await document.fonts.ready
        const button = document.querySelector('#pair-button')
        const heading = document.querySelector('#pair h1')
        const mark = document.querySelector('.brand-mark')
        if (!button || !heading || !mark) throw new Error('Missing mobile pairing content')
        const style = getComputedStyle(button)
        const channels = (value: string): number[] => value.match(/[\d.]+/g)?.map(Number) ?? []
        const luminance = (value: string): number => {
          const rgb = channels(value)
            .slice(0, 3)
            .map((channel) => {
              const scaled = value.startsWith('color(') ? channel : channel / 255
              return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
            })
          const [red, green, blue] = rgb
          if (red === undefined || green === undefined || blue === undefined)
            throw new Error('Expected three RGB colour channels')
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue
        }
        const background = luminance(style.backgroundColor)
        const foreground = luminance(style.color)
        return {
          font: getComputedStyle(document.body).fontFamily,
          headingFont: getComputedStyle(heading).fontFamily,
          headingWeight: getComputedStyle(heading).fontWeight,
          loadedFonts: [...document.fonts]
            .filter((face) => face.status === 'loaded')
            .map((face) => face.family.replaceAll('"', '')),
          fill: style.backgroundColor,
          label: style.color,
          height: button.getBoundingClientRect().height,
          contrast:
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
          surfaceLuminance: luminance(getComputedStyle(document.body).backgroundColor),
          brand: getComputedStyle(mark).backgroundImage.startsWith('url("data:image/svg+xml'),
          chromeMatches:
            document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ===
            getComputedStyle(document.body).backgroundColor,
        }
      })
      expect(appearance.font).toContain('Pliant')
      expect(appearance.headingFont).toContain('Averia Serif Libre')
      expect(appearance.headingWeight).toBe('400')
      expect(appearance.loadedFonts).toContain('Pliant')
      expect(appearance.loadedFonts).toContain('Averia Serif Libre')
      expect(appearance.fill).toBe('rgb(255, 147, 208)')
      expect(appearance.label).toBe('rgb(68, 68, 68)')
      assert.ok(
        appearance.contrast >= 4.5,
        `${theme} primary label contrast: ${String(appearance.contrast)}`,
      )
      assert.ok(appearance.height >= 44, 'Pairing must remain a phone-sized touch target')
      expect(appearance.surfaceLuminance > 0.5).toBe(theme === 'light')
      expect(appearance.brand).toBe(true)
      expect(appearance.chromeMatches).toBe(true)
      await screenshot(`mobile-companion-pair-${theme}.png`)

      await browser.execute(() => {
        localStorage.setItem('copse-mobile-token', 'visual-test-token')
      })
      await browser.refresh()
      await expect($('.group .row')).toBeDisplayed()
      await browser.execute(async () => {
        await document.fonts.ready
      })
      await expect($('#groups')).toHaveText(expect.stringContaining('NEEDS YOU'))
      await expect($('#groups')).toHaveText(expect.stringContaining('WORKING'))
      await expect($('#groups')).toHaveText(expect.stringContaining('RECENT'))
      await expect($('.state.needs-approval')).toHaveText('needs approval')
      await expect($('.state.finished')).toHaveText('finished')
      await screenshot(`mobile-companion-activity-${theme}.png`)

      await $('.group .row').click()
      await expect($('#thread-title')).toHaveText('Review the release')
      await expect($('#messages')).toHaveText(
        expect.stringContaining('</p><img src=x onerror=alert(1)>'),
      )
      expect(await browser.execute(() => document.querySelectorAll('#messages img').length)).toBe(0)
      await expect($('.topbar #back svg')).toExist()
      await expectComposerVisible('message')
      await screenshot(`mobile-companion-thread-${theme}.png`)
      await expect($('#composer')).toBeDisplayed()
      await expect($('#stop')).toBeDisplayed()
      await expect($('.attention-body')).toHaveText('pnpm run check')
      await $('.decision-actions .ui-btn-primary').click()
      await expect($('.attention label')).toHaveText('Which tests should I run?')
      await $('.answer').setValue('Keep this draft during polling')
      await browser.waitUntil(async () => {
        const count = await browser.execute(
          () =>
            performance
              .getEntriesByType('resource')
              .filter((entry) => entry.name.includes('/api/thread/')).length,
        )
        return count >= 3
      })
      await expect($('.answer')).toHaveValue('Keep this draft during polling')
      await screenshot(`mobile-companion-question-${theme}.png`)
      await $('.answer-options .ui-btn').click()
      await expect($('.answer')).toHaveValue('Focused tests')
      await $('.attention > .ui-btn-primary').click()
      await expect($('.attention')).not.toExist()
      await $('#message').setValue('Please run those **tests** and report back.')
      await expectComposerVisible('message')
      await screenshot(`mobile-companion-compose-${theme}.png`)
      await $('#send').click()
      await expect($('#message')).toHaveValue('')
      await expectComposerVisible('message')
      await expect($('#messages')).toHaveText(
        expect.stringContaining('Please run those tests and report back.'),
      )
      await expect($('#messages .message-content strong')).toHaveText('tests')
      await $('#stop').click()
      await expect($('#stop')).not.toBeDisplayed()
      await expect($('#send')).toHaveText('Send')
      await $('#message').setValue('Keep this draft through history')
      const historyLength = await browser.execute(() => history.length)
      await browser.back()
      await expect($('#activity')).toBeDisplayed()
      await expect($('#back')).not.toBeDisplayed()
      await browser.forward()
      await expect($('#thread')).toBeDisplayed()
      await expect($('#message')).toHaveValue('Keep this draft through history')
      await expectComposerVisible('message')
      expect(await browser.execute(() => history.length)).toBe(historyLength)
      await $('#back').click()
      await expect($('#activity')).toBeDisplayed()
      await $('#new-chat').click()
      await expectComposerVisible('new-message')
      await $('#new-message').setValue('Start a fresh release review.')
      await screenshot(`mobile-companion-new-chat-${theme}.png`)
      await $('#new-chat-form button').click()
      await expect($('#thread')).toBeDisplayed()
      await expect($('#messages')).toHaveText(
        expect.stringContaining('Start a fresh release review.'),
      )
    }
  })
})
