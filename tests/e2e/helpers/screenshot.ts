import { join } from 'node:path'
import { browser } from '@wdio/globals'

/** Fixed viewport for committed e2e reference screenshots (see tests/e2e/screenshots/). */
export const E2E_VIEWPORT = { width: 1280, height: 800 } as const

export const E2E_SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

/** Pin the app shell to a fixed size and settle layout before capturing. */
export async function prepareE2eScreenshot(
  size: { width: number; height: number } = E2E_VIEWPORT,
): Promise<void> {
  await browser.execute((viewport) => {
    const app = document.getElementById('app')
    if (!app) return
    const width = Math.min(viewport.width, window.innerWidth)
    const height = Math.min(viewport.height, window.innerHeight)
    app.style.width = `${width}px`
    app.style.height = `${height}px`
    app.style.overflow = 'hidden'
    app.style.boxSizing = 'border-box'
    window.dispatchEvent(new Event('resize'))
  }, size)
  await browser.pause(100)
}

/** Wider frame for three-pane reference shots (projects + chat + right panel). */
export const E2E_THREE_PANE_VIEWPORT = { width: 1600, height: 800 } as const

export async function prepareThreePaneScreenshot(): Promise<void> {
  await browser.execute((viewport) => {
    const app = document.getElementById('app')
    const body = document.getElementById('body')
    if (app) {
      app.style.width = `${viewport.width}px`
      app.style.height = `${viewport.height}px`
      app.style.overflow = 'hidden'
      app.style.boxSizing = 'border-box'
    }
    if (body) {
      body.style.setProperty('--projects-width', '260px')
      body.style.setProperty('--files-width', '480px')
      body.style.setProperty('--tree-width', '200px')
    }
    window.dispatchEvent(new Event('resize'))
  }, E2E_THREE_PANE_VIEWPORT)
  await browser.pause(150)
}

/** Capture the three-pane body with projects sidebar + chat + right panel visible. */
export async function saveThreePaneScreenshot(filename: string): Promise<void> {
  await prepareThreePaneScreenshot()
  const body = await browser.$('#body.three-pane')
  await body.waitForDisplayed({ timeout: 15_000 })
  await body.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/** Capture the app shell at the fixed viewport (excludes OS chrome). */
export async function saveAppScreenshot(filename: string): Promise<void> {
  await prepareE2eScreenshot()
  const app = await browser.$('#app')
  await app.waitForDisplayed({ timeout: 15_000 })
  await app.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/**
 * Maximize chat width and relax overflow clipping so message/table captures are
 * not truncated by the projects sidebar or pane overflow.
 */
export async function prepareChatMessageScreenshot(
  size: { width: number; height: number } = E2E_VIEWPORT,
): Promise<void> {
  await prepareE2eScreenshot(size)
  await browser.execute(() => {
    document.getElementById('pane-projects')?.setAttribute('hidden', '')
    document.getElementById('resizer-projects')?.setAttribute('hidden', '')
    document.getElementById('body')?.style.setProperty('--projects-width', '0px')
    const app = document.getElementById('app')
    if (app) app.style.overflow = 'visible'
    for (const sel of ['#body', '.pane-chat', '.conversation-scroll', '.messages-list']) {
      const el = document.querySelector(sel) as HTMLElement | null
      if (el) el.style.overflow = 'visible'
    }
    window.dispatchEvent(new Event('resize'))
  })
  await browser.pause(100)
}

/** Capture the app shell with projects hidden so chat/table shots are not clipped. */
export async function saveChatPaneScreenshot(filename: string): Promise<void> {
  await prepareChatMessageScreenshot()
  await browser.execute(() => {
    document.querySelector('.message-text table')?.scrollIntoView({ block: 'start' })
  })
  await browser.pause(100)
  const app = await browser.$('#app')
  await app.waitForDisplayed({ timeout: 15_000 })
  await app.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/** Capture a message sub-tree once {@link prepareChatMessageScreenshot} has run. */
export async function savePreparedElementScreenshot(
  selector: string,
  filename: string,
): Promise<void> {
  await prepareChatMessageScreenshot()
  await browser.execute((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'start', inline: 'nearest' })
  }, selector)
  await browser.pause(100)
  const el = await browser.$(selector)
  await el.waitForDisplayed({ timeout: 15_000 })
  await el.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}

/** Capture a single element after pinning the viewport (footer, input bar, etc.). */
export async function saveElementScreenshot(selector: string, filename: string): Promise<void> {
  await prepareE2eScreenshot()
  const el = await browser.$(selector)
  await el.waitForDisplayed({ timeout: 15_000 })
  await el.saveScreenshot(join(E2E_SCREENSHOT_DIR, filename))
}
