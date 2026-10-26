import { mkdirSync } from 'node:fs'
import type { WebviewTag } from 'electron'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedE2eViewport,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { switchTheme, tokenColour } from './helpers/theme.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-code-map-theme-project'
const THREAD_ID = 'e2e-code-map-theme-thread'

async function waitForComposer(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
}

async function openCodeMapMode(): Promise<void> {
  const codeMapBtn = await $('.titlebar-btn[aria-label="Open code map"]').getElement()
  await codeMapBtn.click()
  const pane = await $('#codemap-viewer-host').getElement()
  await browser.waitUntil(async () => await pane.isDisplayed(), {
    timeout: 10_000,
    timeoutMsg: 'expected codemap-viewer-host to open from titlebar',
  })
  await expect(codeMapBtn).toHaveElementClass('active')
}

/** Resolves once the guest has both loaded and painted the host's pushed chrome. */
async function waitForGuestChrome(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const webview = document.querySelector<WebviewTag>('.code-map-webview')
        return !!webview && !webview.isLoading()
      }),
    { timeout: 20_000, timeoutMsg: 'expected the Code Map webview to finish loading' },
  )
  await browser.waitUntil(
    async () => {
      const scheme = await guestChrome()
      return scheme.scheme !== null
    },
    { timeout: 10_000, timeoutMsg: 'expected the Code Map guest to receive a pushed scheme' },
  )
}

/** Reads the guest's own painted chrome back out, independent of any host-side helper. */
async function guestChrome(): Promise<{ scheme: string | null; bg: string }> {
  const result: unknown = await browser.execute(async () => {
    const webview = document.querySelector<WebviewTag>('.code-map-webview')
    if (!webview) throw new Error('Code Map webview missing')
    return webview.executeJavaScript(`(() => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--bg)';
      document.body.append(probe);
      const bg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { scheme: document.documentElement.dataset.scheme ?? null, bg };
    })()`)
  })
  return result as { scheme: string | null; bg: string }
}

describe('code map panel appearance (Copse chrome bridge)', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedE2eViewport()
    const workspaceRoot = seedStableWorkspace()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Code map thread',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    writeSettings({ subagentsEnabled: false, theme: 'dark' })
    await browser.reloadSession()
    await waitForComposer()
  })

  after(() => {
    resetUserData()
  })

  it('pushes the host chrome into the embedded panel and repaints it live', async () => {
    await openCodeMapMode()
    await waitForGuestChrome()

    const hostDarkBg = await tokenColour('--bg-base', 'background-color')
    const darkGuest = await guestChrome()
    expect(darkGuest.scheme).toBe('dark')
    expect(darkGuest.bg).toBe(hostDarkBg)
    await saveElementScreenshot('#codemap-viewer-host', 'code-map-theme-dark.png')

    await switchTheme('light')
    await browser.waitUntil(async () => (await guestChrome()).scheme === 'light', {
      timeout: 10_000,
      timeoutMsg: 'expected the Code Map guest to repaint for light, live',
    })
    const hostLightBg = await tokenColour('--bg-base', 'background-color')
    const lightGuest = await guestChrome()
    expect(lightGuest.bg).toBe(hostLightBg)
    expect(lightGuest.bg).not.toBe(darkGuest.bg)
    await saveElementScreenshot('#codemap-viewer-host', 'code-map-theme-light.png')
  })
})
