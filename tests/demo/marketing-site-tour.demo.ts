import { $, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { E2E_SCREENSHOT_DIR } from '../e2e/helpers/screenshot.ts'

interface TourGeometry {
  copyBottom: number
  comingSoonBottom: number
  demoTop: number
  navBottom: number
  visualTop: number
}

async function measureTour(): Promise<TourGeometry | null> {
  return browser.execute(() => {
    const nav = document.querySelector('.site-nav')
    const copy = document.querySelector('.hero-copy')
    const comingSoon = document.querySelector('.hero-coming-soon')
    const visual = document.getElementById('tour')
    const demo = document.querySelector('.hero-demo')
    if (!nav || !copy || !comingSoon || !visual || !demo) return null

    return {
      copyBottom: copy.getBoundingClientRect().bottom,
      comingSoonBottom: comingSoon.getBoundingClientRect().bottom,
      demoTop: demo.getBoundingClientRect().top,
      navBottom: nav.getBoundingClientRect().bottom,
      visualTop: visual.getBoundingClientRect().top,
    }
  })
}

describe('marketing site Tour anchor', () => {
  it('shows public downloads without exposing the private source repository', async () => {
    await browser.setWindowSize(1280, 800)
    await browser.url('/marketing/index.html')
    await $('.hero-copy').waitForDisplayed()
    await browser.waitUntil(() => browser.execute(() => document.fonts.status === 'loaded'))

    await browser.execute(() => {
      document.documentElement.setAttribute('data-site-mode', 'downloads-live')
    })

    await expect($('.hero-badges .mode-source-private-only')).toBeDisplayed()
    await expect($('.hero-badges .mode-source-private-only')).toHaveText('Free public beta')
    await expect($('.hero-badges .mode-source-live-only')).not.toBeDisplayed()
    const badgeLayout = await browser.execute(() => {
      const badge = document.querySelector<HTMLElement>('.hero-badges .mode-source-private-only')
      const icon = badge?.querySelector<SVGElement>('.badge-icon')
      if (!badge || !icon) return null

      const badgeRect = badge.getBoundingClientRect()
      const iconRect = icon.getBoundingClientRect()
      return {
        display: getComputedStyle(badge).display,
        height: badgeRect.height,
        centerOffset: iconRect.top + iconRect.height / 2 - (badgeRect.top + badgeRect.height / 2),
      }
    })
    expect(badgeLayout).not.toBeNull()
    // An inline-flex child is blockified to `flex` when it participates as a
    // flex item in .hero-badges. The broken publication override computed to
    // `block` and stacked the icon above the label.
    expect(badgeLayout?.display).toBe('flex')
    expect(badgeLayout?.height).toBeLessThanOrEqual(32)
    expect(Math.abs(badgeLayout?.centerOffset ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1)
    await browser.saveScreenshot(
      join(E2E_SCREENSHOT_DIR, 'marketing-site-downloads-live-source-private-hero.png'),
    )

    const download = $(
      '.download-panel .pill-pink[href="https://github.com/copse-dev/copse-releases/releases"]',
    )
    await expect(download).toBeDisplayed()
    await expect(download).toHaveText('Download for macOS')
    await expect($('.download-panel')).toHaveText(expect.stringContaining('Apple Silicon or Intel'))
    await expect($('.download-panel .mode-source-live-only')).not.toBeDisplayed()
    await expect($('.download-pending')).not.toBeDisplayed()
    await expect($('footer a[href="https://github.com/copse-dev/agent-pane"]')).not.toBeDisplayed()

    const panel = $('.download-panel')
    await panel.scrollIntoView({ block: 'center' })
    await browser.waitUntil(async () => {
      const position = await browser.execute(() => {
        const rect = document.getElementById('download')?.getBoundingClientRect()
        return rect ? { bottom: rect.bottom, top: rect.top } : null
      })
      return position !== null && position.top >= 0 && position.bottom <= 800
    })

    await browser.saveScreenshot(
      join(E2E_SCREENSHOT_DIR, 'marketing-site-downloads-live-source-private.png'),
    )
  })

  it('places the floating nav just above the demo with the hero copy out of view', async () => {
    await browser.setWindowSize(1450, 940)
    await browser.url('/marketing/index.html')
    await $('.hero-demo').waitForDisplayed()
    await browser.waitUntil(() => browser.execute(() => document.fonts.status === 'loaded'))
    await expect($('#hero-demo-frame')).toHaveAttribute(
      'src',
      'demo/main/?scenario=landing&embedded=1',
    )

    await $('a[href="#tour"]').click()
    await browser.waitUntil(async () => {
      const geometry = await measureTour()
      return geometry !== null && Math.abs(geometry.visualTop - 72) <= 1
    })

    const geometry = await measureTour()
    expect(geometry).not.toBeNull()
    if (!geometry) throw new Error('Missing marketing tour geometry')

    expect(geometry.copyBottom).toBeLessThanOrEqual(0)
    expect(geometry.comingSoonBottom).toBeLessThanOrEqual(0)
    expect(geometry.demoTop).toBeGreaterThan(geometry.navBottom)
    expect(geometry.demoTop - geometry.navBottom).toBeLessThanOrEqual(28)

    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'marketing-site-tour-anchor.png'))
  })

  it('does not show or load either demo entry point on mobile', async () => {
    await browser.setWindowSize(390, 844)
    await browser.url('/marketing/index.html')
    await $('.hero-copy').waitForDisplayed()
    await browser.waitUntil(() => browser.execute(() => document.fonts.status === 'loaded'))

    const privateBetaBadge = $('.hero-badges .mode-source-private-only')
    await expect(privateBetaBadge).toBeDisplayed()
    await expect(privateBetaBadge).toHaveText('Free public beta')
    expect(
      (await privateBetaBadge.getSize('height')) ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(32)
    await browser.saveScreenshot(
      join(E2E_SCREENSHOT_DIR, 'marketing-site-mobile-private-beta-badge.png'),
    )

    await expect($('.hero-visual')).not.toBeDisplayed()
    await expect($('.hero-demo')).not.toBeDisplayed()
    await expect($('.hero-demo-popout')).not.toBeDisplayed()
    await expect($('a[href="#tour"]')).not.toBeDisplayed()

    const frameSource = await browser.execute(() =>
      document.getElementById('hero-demo-frame')?.getAttribute('src'),
    )
    expect(frameSource).toBeNull()

    await browser.execute(() => {
      const manifesto = document.querySelector('.manifesto')
      if (manifesto) window.scrollTo({ top: manifesto.getBoundingClientRect().top + scrollY - 220 })
    })
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'marketing-site-mobile-no-demo.png'))
  })
})
