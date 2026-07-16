import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedPortraitRightPanelFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'

async function savePortraitElementScreenshot(selector: string, filename: string): Promise<void> {
  await prepareE2eScreenshot({ width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT })
  const el = await $(selector)
  await el.waitForDisplayed({ timeout: 15_000 })
  await el.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

const PORTRAIT_WIDTH = 760
const PORTRAIT_HEIGHT = 1180

async function setPortraitWindow(): Promise<void> {
  const alreadyPortrait = await browser.execute(() => {
    const { innerWidth: width, innerHeight: height } = window
    return height >= 700 && height / width >= 1.35
  })
  if (alreadyPortrait) return

  await browser.execute(
    (width, height) => {
      window.resizeTo(width, height)
    },
    PORTRAIT_WIDTH,
    PORTRAIT_HEIGHT,
  )
  await browser.waitUntil(
    async () => {
      const size = await browser.execute(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      return size.height >= 700 && size.height / size.width >= 1.35
    },
    {
      timeout: 30_000,
      timeoutMsg: 'expected Electron window to resize to a tall portrait viewport',
    },
  )
}

async function setProjectsWidth(px: number): Promise<void> {
  await browser.execute((width) => {
    document.getElementById('body')?.style.setProperty('--projects-width', `${width}px`)
    window.dispatchEvent(new Event('resize'))
  }, px)
  await browser.pause(150)
}

async function openPortraitChrome(): Promise<void> {
  resetUserData()
  seedPortraitRightPanelFixture(
    process.cwd(),
    true,
    {
      width: PORTRAIT_WIDTH,
      height: PORTRAIT_HEIGHT,
    },
    { okfMemoriesEnabled: true, roadmapPlansEnabled: true },
  )
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await setPortraitWindow()
  await browser.waitUntil(
    async () => (await (await $('#app')).getAttribute('class'))?.includes('is-portrait-chrome'),
    { timeout: 5_000, timeoutMsg: 'expected portrait chrome class on #app' },
  )
  // Give the chat column room so every labeled mode fits before assertions.
  await setProjectsWidth(160)
  // Experimental Memories / Roadmap buttons reveal asynchronously after settings.get.
  await $('.portrait-panel-bar .titlebar-text-btn[aria-label="Open memories"]').waitForDisplayed({
    timeout: 10_000,
  })
  await $('.portrait-panel-bar .titlebar-text-btn[aria-label="Open roadmap"]').waitForDisplayed({
    timeout: 10_000,
  })
}

describe('portrait panel controls row', () => {
  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('shows a labeled panel row under the footer and icon-only secondary titlebar buttons', async () => {
    await openPortraitChrome()

    const portraitBar = await $('.portrait-panel-bar')
    await expect(portraitBar).toBeDisplayed()
    await expect($('.portrait-panel-overflow')).not.toBeDisplayed()

    const labeled = [
      { label: 'Toggle right panel', text: 'Panel' },
      { label: 'Open terminal', text: 'Terminal' },
      { label: 'Open changes', text: 'Changes' },
      { label: 'Open pull requests', text: 'PRs' },
      { label: 'Open memories', text: 'Memories' },
      { label: 'Open roadmap', text: 'Roadmap' },
      { label: 'Open browser', text: 'Browser' },
    ]
    for (const button of labeled) {
      const btn = await portraitBar.$(`.titlebar-text-btn[aria-label="${button.label}"]`)
      await expect(btn).toBeDisplayed()
      await expect(btn).toHaveText(expect.stringContaining(button.text))
    }

    // Titlebar keeps Panel labeled; secondary mode buttons drop their text.
    const titlebarPanel = await $('#titlebar .titlebar-text-btn[aria-label="Toggle right panel"]')
    await expect(titlebarPanel).toHaveText('Panel')
    const titlebarTerminalLabel = await $(
      '#titlebar .titlebar-text-btn[aria-label="Open terminal"] .titlebar-btn-label',
    )
    await expect(titlebarTerminalLabel).not.toBeDisplayed()

    const layout = await browser.execute(() => {
      const footer = document.querySelector('.input-footer')!.getBoundingClientRect()
      const bar = document.querySelector('.portrait-panel-bar')!.getBoundingClientRect()
      const settings = document.querySelector('.projects-settings-btn')!.getBoundingClientRect()
      return {
        footerBottom: footer.bottom,
        barTop: bar.top,
        barBottom: bar.bottom,
        settingsTop: settings.top,
        settingsBottom: settings.bottom,
        settingsHeight: settings.height,
        barHeight: bar.height,
      }
    })
    expect(layout.barTop).toBeGreaterThanOrEqual(layout.footerBottom - 1)
    // Same band as Settings — shared `--chrome-action-band-height`. Tops,
    // bottoms, and heights must agree so the separator line is continuous.
    expect(layout.barHeight).toBe(layout.settingsHeight)
    expect(layout.barTop).toBe(layout.settingsTop)
    expect(layout.barBottom).toBe(layout.settingsBottom)

    await prepareE2eScreenshot({ width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT })
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'portrait-panel-controls-chrome.png'))
    // Crop the Settings | panel-bar seam so height alignment is reviewable.
    await browser.execute(() => {
      const settings = document.querySelector('.projects-settings-btn')
      const bar = document.querySelector('.portrait-panel-bar')
      if (!settings || !bar) throw new Error('missing settings or portrait bar')
      const top =
        Math.min(settings.getBoundingClientRect().top, bar.getBoundingClientRect().top) - 8
      const host = document.createElement('div')
      host.id = 'e2e-portrait-seam'
      host.style.cssText = `position:fixed;left:0;right:0;top:${String(top)}px;bottom:0;z-index:9999;pointer-events:none;`
      document.body.append(host)
    })
    await savePortraitElementScreenshot(
      '#e2e-portrait-seam',
      'portrait-panel-controls-settings-seam.png',
    )
    await browser.execute(() => document.getElementById('e2e-portrait-seam')?.remove())
    await savePortraitElementScreenshot('#titlebar', 'portrait-panel-controls-titlebar.png')
    await savePortraitElementScreenshot('#input-bar', 'portrait-panel-controls-footer-row.png')
    await savePortraitElementScreenshot(
      '.portrait-panel-bar',
      'portrait-panel-controls-all-buttons.png',
    )

    // Opening a panel from the bottom row stacks it below chat and keeps the row.
    await portraitBar.$('.titlebar-text-btn[aria-label="Open terminal"]').click()
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(
      async () =>
        (await (await $('#body')).getAttribute('class'))?.includes('is-right-panel-horizontal'),
      { timeout: 5_000, timeoutMsg: 'expected stacked right-panel layout after opening Terminal' },
    )
    await expect(
      portraitBar.$('.titlebar-text-btn[aria-label="Open terminal"]'),
    ).toHaveElementClass('active')

    const stacked = await browser.execute(() => {
      const bar = document.querySelector('.portrait-panel-bar')!.getBoundingClientRect()
      const files = document.getElementById('pane-files')!.getBoundingClientRect()
      const settings = document.querySelector('.projects-settings-btn')!.getBoundingClientRect()
      return {
        barBottom: bar.bottom,
        filesTop: files.top,
        settingsHeight: settings.height,
        barHeight: bar.height,
      }
    })
    expect(stacked.filesTop).toBeGreaterThanOrEqual(stacked.barBottom - 2)
    expect(Math.abs(stacked.barHeight - stacked.settingsHeight)).toBeLessThanOrEqual(1)

    await prepareE2eScreenshot({ width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT })
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'portrait-panel-controls-with-panel.png'))
  })

  it('collapses trailing modes into a … menu when the chat column is cramped', async () => {
    await openPortraitChrome()

    // Widen the projects pane until the labeled row must spill into overflow.
    await setProjectsWidth(420)
    await browser.waitUntil(
      async () => {
        const overflow = await $('.portrait-panel-overflow')
        return overflow.isExisting() && (await overflow.isDisplayed())
      },
      { timeout: 5_000, timeoutMsg: 'expected portrait panel overflow trigger when cramped' },
    )

    await expect(
      $('.portrait-panel-bar .titlebar-text-btn[aria-label="Toggle right panel"]'),
    ).toBeDisplayed()
    await expect(
      $('.portrait-panel-bar .titlebar-text-btn[aria-label="Open browser"]'),
    ).not.toBeDisplayed()

    await savePortraitElementScreenshot(
      '.portrait-panel-bar',
      'portrait-panel-controls-overflow.png',
    )

    await $('.portrait-panel-overflow-trigger').click()
    const menu = await $('.portrait-panel-overflow-menu')
    await expect(menu).toBeDisplayed()
    const items = await $$('.portrait-panel-overflow-item')
    expect(items.length).toBeGreaterThan(0)
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.portrait-panel-overflow-item')).map((el) =>
        (el.textContent ?? '').trim(),
      ),
    )
    expect(labels).toContain('Browser')

    await savePortraitElementScreenshot('#input-bar', 'portrait-panel-controls-overflow-open.png')

    const browserItem = await menu.$('.portrait-panel-overflow-item*=Browser')
    await browserItem.waitForClickable({ timeout: 5_000 })
    await browserItem.click()
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document
              .querySelector('.portrait-panel-bar [data-panel-control="browser"]')
              ?.classList.contains('active') === true,
        ),
      { timeout: 5_000, timeoutMsg: 'expected Browser mode active after overflow pick' },
    )
  })
})
