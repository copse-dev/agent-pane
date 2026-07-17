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

/** Wide enough for all labeled modes at a normal projects width on CI fonts. */
const PORTRAIT_WIDTH = 920
const PORTRAIT_HEIGHT = 1180

async function setProjectsWidth(px: number): Promise<void> {
  await browser.execute((width) => {
    document.getElementById('body')?.style.setProperty('--projects-width', `${width}px`)
    window.dispatchEvent(new Event('resize'))
  }, px)
  await browser.pause(150)
}

/**
 * Narrow the app shell in CSS (not via OS window.resizeTo). CI displays often
 * refuse tall Electron windows — same flake that CI-excludes
 * `portrait-right-panel.e2e.ts`. Portrait chrome itself is forced by seeding
 * `rightPanelPosition: 'bottom'`; this just gives the chat column a stable
 * portrait-ish width for layout + overflow assertions.
 */
async function pinPortraitAppShell(): Promise<void> {
  await browser.execute((width) => {
    const app = document.getElementById('app')
    if (!app) throw new Error('missing #app')
    // Width only — forcing a taller-than-display height makes Electron screenshot
    // captures hang on some CI / VNC setups.
    app.style.width = `${width}px`
    app.style.maxWidth = `${width}px`
    app.style.boxSizing = 'border-box'
    window.dispatchEvent(new Event('resize'))
  }, PORTRAIT_WIDTH)
  await browser.pause(100)
}

async function openPortraitChrome(): Promise<void> {
  resetUserData()
  // Pin the panel to `bottom` so portrait chrome activates without needing a
  // tall OS window. CI runners often clamp `window.resizeTo` / windowBounds
  // (same reason `portrait-right-panel.e2e.ts` is CI-excluded), and the chrome
  // affordances are identical for bottom-pinned and auto-portrait layouts.
  seedPortraitRightPanelFixture(
    process.cwd(),
    true,
    {
      width: PORTRAIT_WIDTH,
      height: PORTRAIT_HEIGHT,
    },
    {
      okfMemoriesEnabled: true,
      roadmapPlansEnabled: true,
      rightPanelPosition: 'bottom',
    },
  )
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await pinPortraitAppShell()
  await browser.waitUntil(
    async () => (await (await $('#app')).getAttribute('class'))?.includes('is-portrait-chrome'),
    { timeout: 5_000, timeoutMsg: 'expected portrait chrome class on #app' },
  )
  // Keep a normal projects width so Settings stays band-aligned with the bar.
  // The app shell is pinned wide enough (PORTRAIT_WIDTH) that CI font metrics
  // still fit every labeled mode without overflow.
  await setProjectsWidth(200)
  // Experimental Memories / Roadmap buttons reveal asynchronously after settings.get.
  await $('.portrait-panel-bar .titlebar-text-btn[aria-label="Open memories"]').waitForDisplayed({
    timeout: 10_000,
  })
  await $('.portrait-panel-bar .titlebar-text-btn[aria-label="Open roadmap"]').waitForDisplayed({
    timeout: 10_000,
  })
  await browser.waitUntil(
    async () => {
      const overflow = await $('.portrait-panel-overflow')
      return !(await overflow.isExisting()) || !(await overflow.isDisplayed())
    },
    { timeout: 5_000, timeoutMsg: 'expected all portrait panel modes to fit without overflow' },
  )
}

describe('portrait panel controls row', () => {
  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('docks one composer-width mode strip to the seam and keeps buttons unboxed', async () => {
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
      const bar = document.querySelector('.portrait-panel-bar')!
      const settings = document.querySelector('.projects-settings-btn')!
      const paneChat = document.getElementById('pane-chat')!
      const inputBar = document.getElementById('input-bar')!
      const barStyle = getComputedStyle(bar)
      const barRect = bar.getBoundingClientRect()
      const inputRect = inputBar.getBoundingClientRect()
      const settingsRect = settings.getBoundingClientRect()
      const paneChatRect = paneChat.getBoundingClientRect()
      return {
        footerBottom: footer.bottom,
        inputBottom: inputRect.bottom,
        inputLeft: inputRect.left,
        inputRight: inputRect.right,
        inputWidth: inputRect.width,
        barTop: barRect.top,
        barBottom: barRect.bottom,
        barLeft: barRect.left,
        barRight: barRect.right,
        barWidth: barRect.width,
        barBorderTop: barStyle.borderTopWidth,
        barBorderRight: barStyle.borderRightWidth,
        barBorderBottom: barStyle.borderBottomWidth,
        barBorderLeft: barStyle.borderLeftWidth,
        barBottomLeftRadius: barStyle.borderBottomLeftRadius,
        barBottomRightRadius: barStyle.borderBottomRightRadius,
        paneChatBottom: paneChatRect.bottom,
        parentId: bar.parentElement?.id,
        settingsHeight: settingsRect.height,
        settingsTop: settingsRect.top,
        settingsBottom: settingsRect.bottom,
        barHeight: barRect.height,
        barCssHeight: getComputedStyle(bar).height,
        settingsCssHeight: getComputedStyle(settings).height,
      }
    })
    expect(layout.parentId).toBe('pane-chat')
    expect(layout.inputBottom).toBeLessThan(layout.barTop)
    expect(layout.footerBottom).toBeLessThan(layout.barTop)
    expect(Math.abs(layout.barLeft - layout.inputLeft)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.barRight - layout.inputRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.barWidth - layout.inputWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.barBottom - layout.paneChatBottom)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.barTop - layout.settingsTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(layout.barBottom - layout.settingsBottom)).toBeLessThanOrEqual(1)
    // Same CSS band as Settings (shared `--chrome-action-band-height`). Absolute
    // tops can drift when the app shell is CSS-sized inside a larger Electron
    // window on CI; matching computed heights is the product invariant. The
    // seam screenshot below covers visual alignment.
    expect(layout.barCssHeight).toBe(layout.settingsCssHeight)
    expect(Math.abs(layout.barHeight - layout.settingsHeight)).toBeLessThanOrEqual(1)
    expect(layout.barBorderTop).toBe('1px')
    expect(layout.barBorderRight).toBe('1px')
    expect(layout.barBorderBottom).toBe('0px')
    expect(layout.barBorderLeft).toBe('1px')
    expect(layout.barBottomLeftRadius).toBe('0px')
    expect(layout.barBottomRightRadius).toBe('0px')

    const unboxedButtons = await browser.execute(() =>
      ['explorer', 'terminal', 'changes'].map((id) => {
        const element = document.querySelector<HTMLElement>(
          `.portrait-panel-bar [data-panel-control="${id}"]`,
        )!
        const style = getComputedStyle(element)
        return {
          id,
          height: element.getBoundingClientRect().height,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          borderTop: style.borderTopWidth,
          borderRight: style.borderRightWidth,
          borderBottom: style.borderBottomWidth,
          borderLeft: style.borderLeftWidth,
        }
      }),
    )
    for (const button of unboxedButtons) {
      expect(button.height).toBeGreaterThanOrEqual(24)
      expect(button.paddingLeft).toBe('8px')
      expect(button.paddingRight).toBe('8px')
      expect(button.borderTop).toBe('0px')
      expect(button.borderRight).toBe('0px')
      expect(button.borderBottom).toBe('0px')
      expect(button.borderLeft).toBe('0px')
    }

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

    // Opening Changes from the bottom row stacks it below chat and keeps the row.
    await portraitBar.$('.titlebar-text-btn[aria-label="Open changes"]').click()
    await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
    await browser.waitUntil(
      async () =>
        (await (await $('#body')).getAttribute('class'))?.includes('is-right-panel-horizontal'),
      { timeout: 5_000, timeoutMsg: 'expected stacked right-panel layout after opening Changes' },
    )
    await expect(portraitBar.$('.titlebar-text-btn[aria-label="Open changes"]')).toHaveElementClass(
      'active',
    )

    const stacked = await browser.execute(() => {
      const bar = document.querySelector('.portrait-panel-bar')!.getBoundingClientRect()
      const files = document.getElementById('pane-files')!.getBoundingClientRect()
      const resizer = document.getElementById('resizer-files')!
      const resizerRect = resizer.getBoundingClientRect()
      const filesStyle = getComputedStyle(document.getElementById('pane-files')!)
      const settings = document.querySelector('.projects-settings-btn')!.getBoundingClientRect()
      return {
        barBottom: bar.bottom,
        filesTop: files.top,
        resizerTop: resizerRect.top,
        resizerBottom: resizerRect.bottom,
        resizerHeight: resizerRect.height,
        filesBorderTop: filesStyle.borderTopWidth,
        settingsHeight: settings.height,
        barHeight: bar.height,
      }
    })
    expect(Math.abs(stacked.resizerTop - stacked.barBottom)).toBeLessThanOrEqual(1)
    expect(Math.abs(stacked.filesTop - stacked.resizerBottom)).toBeLessThanOrEqual(1)
    expect(stacked.resizerHeight).toBe(1)
    expect(stacked.filesBorderTop).toBe('0px')
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
