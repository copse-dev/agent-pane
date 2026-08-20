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
  it('places the floating nav just above the demo with the hero copy out of view', async () => {
    await browser.setWindowSize(1450, 940)
    await browser.url('/marketing/index.html')
    await $('.hero-demo').waitForDisplayed()
    await browser.waitUntil(() => browser.execute(() => document.fonts.status === 'loaded'))

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
})
