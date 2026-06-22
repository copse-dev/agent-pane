import { $, browser, expect } from '@wdio/globals'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-portrait-split-project'
const PORTRAIT_WIDTH = 760
const PORTRAIT_HEIGHT = 1180

async function waitForComposer(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
}

async function setPortraitWindow(): Promise<void> {
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
      return size.height >= 700 && size.width / size.height <= 0.8
    },
    {
      timeout: 5_000,
      timeoutMsg: 'expected Electron window to resize to a tall portrait aspect ratio',
    },
  )
}

async function openTerminalPanel(): Promise<void> {
  await $('.titlebar-btn[aria-label="Open terminal"]').click()
  await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
  await $('.terminal-container .xterm').waitForExist({ timeout: 15_000 })
}

describe('portrait split panels', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
    await setPortraitWindow()
    await waitForComposer()
  })

  after(() => {
    resetUserData()
  })

  it('splits by default, exposes the setting, and disables the split when toggled off', async () => {
    await openTerminalPanel()

    const layout = await browser.execute(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect()
        return bounds
          ? {
              top: bounds.top,
              right: bounds.right,
              bottom: bounds.bottom,
              left: bounds.left,
              width: bounds.width,
            }
          : undefined
      }
      return {
        bodyHasClass: document.body.classList.contains('portrait-split-panels-enabled'),
        projects: rect('#pane-projects'),
        chat: rect('#pane-chat'),
        files: rect('#pane-files'),
        sidebar: rect('#right-sidebar'),
        terminal: rect('#terminals-viewer-host'),
        input: rect('#input-bar'),
        windowHeight: window.innerHeight,
      }
    })

    expect(layout.bodyHasClass).toBe(true)
    expect(layout.projects).toBeDefined()
    expect(layout.chat).toBeDefined()
    expect(layout.files).toBeDefined()
    expect(layout.sidebar).toBeDefined()
    expect(layout.terminal).toBeDefined()
    expect(layout.input).toBeDefined()

    expect(layout.projects!.top).toBe(layout.chat!.top)
    expect(Math.abs(layout.projects!.bottom - layout.files!.top)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.chat!.bottom - layout.files!.top)).toBeLessThanOrEqual(2)
    expect(layout.files!.top).toBeGreaterThan(layout.projects!.top)
    expect(layout.sidebar!.left).toBe(layout.projects!.left)
    expect(Math.abs(layout.sidebar!.width - layout.projects!.width)).toBeLessThanOrEqual(2)
    expect(layout.terminal!.left).toBeGreaterThan(layout.sidebar!.right)
    expect(Math.abs(layout.input!.bottom - layout.files!.top)).toBeLessThanOrEqual(2)
    expect(Math.abs(layout.files!.top - layout.windowHeight / 2)).toBeLessThanOrEqual(48)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'portrait-split-panels-enabled.png'))

    await $('.titlebar-settings-btn').click()
    await $('.settings-nav-btn[data-section="appearance"]').click()
    const checkbox = await $('input[name="portraitSplitPanelsEnabled"]')
    await checkbox.waitForDisplayed({ timeout: 5_000 })
    await expect(checkbox).toBeChecked()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'portrait-split-panels-setting.png'))
    await checkbox.click()
    await $('.settings-buttons button[type="submit"]').click()
    await browser.waitUntil(
      async () =>
        !(await browser.execute(() =>
          document.body.classList.contains('portrait-split-panels-enabled'),
        )),
      {
        timeout: 5_000,
        timeoutMsg: 'expected portrait split class to be removed after saving setting',
      },
    )

    const disabledLayout = await browser.execute(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect()
        return bounds
          ? {
              top: bounds.top,
              right: bounds.right,
              bottom: bounds.bottom,
              left: bounds.left,
              width: bounds.width,
            }
          : undefined
      }
      return {
        bodyHasClass: document.body.classList.contains('portrait-split-panels-enabled'),
        chat: rect('#pane-chat'),
        files: rect('#pane-files'),
        sidebar: rect('#right-sidebar'),
        terminal: rect('#terminals-viewer-host'),
      }
    })

    expect(disabledLayout.bodyHasClass).toBe(false)
    expect(disabledLayout.chat).toBeDefined()
    expect(disabledLayout.files).toBeDefined()
    expect(disabledLayout.sidebar).toBeDefined()
    expect(disabledLayout.terminal).toBeDefined()

    expect(disabledLayout.files!.top).toBe(disabledLayout.chat!.top)
    expect(disabledLayout.files!.left).toBeGreaterThan(disabledLayout.chat!.left)
    expect(disabledLayout.terminal!.left).toBeGreaterThan(disabledLayout.sidebar!.right)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'portrait-split-panels-disabled.png'))
  })
})
