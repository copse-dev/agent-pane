import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'

const PROJECT_ID = 'e2e-panel-toggle-project'

type ChordInit = {
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  key: string
  code?: string
}

async function waitForComposer(): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
}

async function pressPanelChord(chord: ChordInit, target?: 'document' | 'composer'): Promise<void> {
  await browser.execute(
    (c, where) => {
      const el = where === 'composer' ? document.querySelector('.prompt-input') : document
      if (!el) return
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: c.ctrl ?? false,
          metaKey: c.meta ?? false,
          shiftKey: c.shift ?? false,
          key: c.key,
          ...(c.code === undefined ? {} : { code: c.code }),
        }),
      )
    },
    chord,
    target ?? 'document',
  )
}

async function focusOutsideComposer(): Promise<void> {
  await browser.execute(() => {
    document.getElementById('conversation')?.focus()
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function closeRightPanelIfOpen(): Promise<void> {
  const pane = await $('#pane-files').getElement()
  if (await pane.isDisplayed()) {
    await pressPanelChord({ ctrl: true, key: 'j' })
    await browser.waitUntil(async () => !(await pane.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'expected pane-files to hide before shortcut test',
    })
  }
}

describe('right panel toggle and shortcuts', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    await browser.reloadSession()
    await waitForComposer()
    // A prior spec can leave the first-run overlay visible across the app
    // relaunch. Its header covers the titlebar controls this spec exercises.
    const onboarding = $('#onboarding-dialog')
    if (await onboarding.isDisplayed()) {
      await $('#onboarding-skip').click()
      await onboarding.waitForDisplayed({ reverse: true, timeout: 10_000 })
    }
  })

  after(() => {
    resetUserData()
  })

  it('opens and closes the files panel from the titlebar', async () => {
    const pane = await $('#pane-files').getElement()
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]').getElement()

    await closeRightPanelIfOpen()
    await expect(pane).not.toBeDisplayed()

    await panelBtn.click()
    await pane.waitForDisplayed({ timeout: 5_000 })
    await expect(panelBtn).toHaveElementClass('active')

    await panelBtn.click()
    await browser.waitUntil(async () => !(await pane.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'expected pane-files to hide after second toggle',
    })
  })

  it('opens terminal mode from the titlebar', async () => {
    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]').getElement()

    await terminalBtn.click()
    // Linux CI has no OS sandbox, so the terminal open itself prompts first.
    await approveUnsandboxedTerminalIfPrompted()

    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect(terminalBtn).toHaveElementClass('active')
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })
  })

  it('toggles the right panel with Ctrl/Cmd+J', async () => {
    const pane = await $('#pane-files').getElement()
    await closeRightPanelIfOpen()
    await focusOutsideComposer()

    await pressPanelChord({ ctrl: true, key: 'j' })
    await pane.waitForDisplayed({ timeout: 5_000 })
    await expect($('.titlebar-btn[aria-label="Toggle right panel"]')).toHaveElementClass('active')

    await pressPanelChord({ ctrl: true, key: 'j' })
    await browser.waitUntil(async () => !(await pane.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'expected pane-files to hide after Ctrl+J',
    })
  })

  it('hides and shows the projects sidebar with Ctrl/Cmd+B and the titlebar button', async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const sidebar = await $('#pane-projects').getElement()
    const toggle = await $('.titlebar-sidebar-btn').getElement()
    await focusOutsideComposer()
    await sidebar.waitForDisplayed({ timeout: 5_000 })

    await pressPanelChord({ ctrl: true, key: 'b' })
    await browser.waitUntil(async () => !(await sidebar.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'expected pane-projects to hide after Ctrl+B',
    })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'sidebar-hidden.png'))

    await toggle.click()
    await sidebar.waitForDisplayed({ timeout: 5_000 })
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'sidebar-shown.png'))
  })

  it('lets a maximized right panel cover the hidden projects sidebar', async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const sidebarToggle = await $('.titlebar-sidebar-btn').getElement()
    const panel = await $('#pane-files').getElement()
    const panelToggle = await $('.titlebar-btn[aria-label="Toggle right panel"]').getElement()
    await closeRightPanelIfOpen()
    await panelToggle.click()
    await panel.waitForDisplayed({ timeout: 5_000 })
    await $('.pane-maximize-btn').click()
    await browser.waitUntil(
      async () => (await $('.pane-maximize-btn').getAttribute('aria-pressed')) === 'true',
      { timeout: 5_000, timeoutMsg: 'expected the right panel to maximize' },
    )

    await sidebarToggle.click()
    await browser.waitUntil(async () => !(await $('#pane-projects').isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'expected the projects sidebar to hide',
    })
    const bounds = await browser.execute(() => {
      const body = document.getElementById('body')?.getBoundingClientRect()
      const pane = document.getElementById('pane-files')?.getBoundingClientRect()
      return { bodyLeft: body?.left ?? -1, paneLeft: pane?.left ?? -1 }
    })
    assert.ok(
      bounds.paneLeft <= bounds.bodyLeft + 1,
      `expected maximized pane at body left edge, got ${JSON.stringify(bounds)}`,
    )
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'sidebar-hidden-panel-maximized.png'))

    await sidebarToggle.click()
    await $('.pane-maximize-btn').click()
    await panelToggle.click()
  })

  it('opens explorer with Ctrl/Cmd+Shift+E', async () => {
    await closeRightPanelIfOpen()
    await focusOutsideComposer()
    await pressPanelChord({ ctrl: true, shift: true, key: 'E' })
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect($('.titlebar-btn[aria-label="Toggle right panel"]')).toHaveElementClass('active')
  })

  it('opens terminal with Ctrl/Cmd+`', async () => {
    await closeRightPanelIfOpen()
    await focusOutsideComposer()
    await pressPanelChord({ ctrl: true, key: '`', code: 'Backquote' })
    await approveUnsandboxedTerminalIfPrompted()
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect($('.titlebar-btn[aria-label="Open terminal"]')).toHaveElementClass('active')
    await $('.terminal-container .xterm').waitForExist({ timeout: 30_000 })
  })

  it('opens changes with Ctrl/Cmd+Shift+G', async () => {
    await closeRightPanelIfOpen()
    await focusOutsideComposer()
    await pressPanelChord({ ctrl: true, shift: true, key: 'G' })
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect($('.titlebar-btn[aria-label="Open changes"]')).toHaveElementClass('active')
    await $('#git-changes-host').waitForDisplayed({ timeout: 5_000 })
  })

  it('does not toggle the panel while typing in the composer', async () => {
    await closeRightPanelIfOpen()
    const pane = await $('#pane-files').getElement()
    const composer = await $('.prompt-input').getElement()
    await composer.click()
    await pressPanelChord({ ctrl: true, key: 'j' }, 'composer')
    await browser.waitUntil(async () => !(await pane.isDisplayed()), {
      timeout: 2_000,
      timeoutMsg: 'expected pane-files to stay hidden when Ctrl+J is pressed in composer',
    })
  })
})
