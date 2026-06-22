import { $, browser, expect } from '@wdio/globals'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-portrait-split-project'
const PORTRAIT_WIDTH = 760
const PORTRAIT_HEIGHT = 1180

async function bootPortraitProject(portraitSplitPanelsEnabled?: boolean): Promise<void> {
  resetUserData()
  seedEmptyProject(process.cwd(), PROJECT_ID, { portraitSplitPanelsEnabled })
  await browser.reloadSession()
  await browser.setWindowSize(PORTRAIT_WIDTH, PORTRAIT_HEIGHT)
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
}

async function openTerminalPanel(): Promise<void> {
  await $('.titlebar-btn[aria-label="Open terminal"]').click()
  await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
  await $('.terminal-container .xterm').waitForExist({ timeout: 15_000 })
}

describe('portrait split panels', () => {
  before(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('splits projects/chat above sidebar/right-panel content by default in portrait', async () => {
    await bootPortraitProject()
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
  })

  it('keeps the traditional side-by-side layout when disabled', async () => {
    await bootPortraitProject(false)
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
        chat: rect('#pane-chat'),
        files: rect('#pane-files'),
        sidebar: rect('#right-sidebar'),
        terminal: rect('#terminals-viewer-host'),
      }
    })

    expect(layout.bodyHasClass).toBe(false)
    expect(layout.chat).toBeDefined()
    expect(layout.files).toBeDefined()
    expect(layout.sidebar).toBeDefined()
    expect(layout.terminal).toBeDefined()

    expect(layout.files!.top).toBe(layout.chat!.top)
    expect(layout.files!.left).toBeGreaterThan(layout.chat!.left)
    expect(layout.terminal!.left).toBeGreaterThan(layout.sidebar!.right)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'portrait-split-panels-disabled.png'))
  })

  it('shows the setting as enabled by default', async () => {
    await bootPortraitProject()

    await $('.titlebar-settings-btn').click()
    const checkbox = await $('input[name="portraitSplitPanelsEnabled"]')
    await checkbox.waitForDisplayed({ timeout: 5_000 })
    await expect(checkbox).toBeChecked()

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'portrait-split-panels-setting.png'))
  })
})
