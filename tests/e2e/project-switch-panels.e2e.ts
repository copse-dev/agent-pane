import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedProjectSwitchFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

async function clickProject(name: string): Promise<void> {
  const row = await $(`.project-row*=${name}`)
  await row.waitForExist({ timeout: 10_000 })
  await row.click()
}

async function openTerminalPane(): Promise<void> {
  const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
  await terminalBtn.click()
  await $('#pane-files').waitForDisplayed({ timeout: 10_000 })
  await expect(terminalBtn).toHaveElementClass('active')
}

async function terminalModeActive(): Promise<boolean> {
  const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
  const cls = await terminalBtn.getAttribute('class')
  return cls?.includes('active') ?? false
}

async function visibleTerminalTabCount(): Promise<number> {
  return browser.execute(() => {
    const tabs = document.querySelectorAll('.terminals-tab')
    let visible = 0
    for (const tab of tabs) {
      if (!(tab as HTMLElement).hidden) visible += 1
    }
    return visible
  })
}

// Visual eval for #502: terminal tabs and panel mode are scoped per project.
describe('project switch panel and terminal scoping', () => {
  before(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('restores each project terminal tabs and panel mode across A→B→A', async () => {
    resetUserData()
    seedProjectSwitchFixture(process.cwd())
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await openTerminalPane()
    await $('.terminals-new-btn').click()
    await browser.waitUntil(async () => (await visibleTerminalTabCount()) >= 1, {
      timeout: 10_000,
      timeoutMsg: 'expected a terminal tab on project A',
    })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'project-switch-a-terminal.png'))

    await clickProject('Project B')
    await browser.waitUntil(async () => !(await terminalModeActive()), {
      timeout: 15_000,
      timeoutMsg: 'expected project B to start with the right panel closed on first visit',
    })
    expect(await visibleTerminalTabCount()).toBe(0)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'project-switch-b.png'))

    await openTerminalPane()
    await $('.terminals-new-btn').click()
    await browser.waitUntil(async () => (await visibleTerminalTabCount()) >= 1, {
      timeout: 10_000,
      timeoutMsg: 'expected a terminal tab on project B',
    })

    await clickProject('Project A')
    await browser.waitUntil(async () => terminalModeActive(), {
      timeout: 15_000,
      timeoutMsg: 'expected project A terminal mode to restore',
    })
    await browser.waitUntil(async () => (await visibleTerminalTabCount()) >= 1, {
      timeout: 10_000,
      timeoutMsg: 'expected project A terminal tab to reappear',
    })

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'project-switch-a-restored.png'))
  })
})
