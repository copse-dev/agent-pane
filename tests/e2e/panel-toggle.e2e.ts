import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

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
          code: c.code,
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
  const pane = await $('#pane-files')
  if (await pane.isDisplayed()) {
    await pressPanelChord({ ctrl: true, key: 'b' })
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
  })

  after(() => {
    resetUserData()
  })

  it('opens and closes the files panel from the titlebar', async () => {
    const pane = await $('#pane-files')
    const panelBtn = await $('.titlebar-btn[aria-label="Toggle right panel"]')

    await closeRightPanelIfOpen()
    await expect(pane).not.toBeDisplayed()

    await panelBtn.click()
    await pane.waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Explorer"]')).toHaveElementClass('is-active')

    await panelBtn.click()
    await browser.waitUntil(async () => !(await pane.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'expected pane-files to hide after second toggle',
    })
  })

  it('opens terminal mode from the titlebar', async () => {
    const terminalBtn = await $('.titlebar-btn[aria-label="Open terminal"]')
    await terminalBtn.click()

    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Terminal"]')).toHaveElementClass('is-active')
    await $('.terminal-container .xterm').waitForExist({ timeout: 15_000 })
  })

  it('toggles the right panel with Ctrl/Cmd+B and Ctrl/Cmd+J', async () => {
    const pane = await $('#pane-files')
    await closeRightPanelIfOpen()
    await focusOutsideComposer()

    await pressPanelChord({ ctrl: true, key: 'b' })
    await pane.waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Explorer"]')).toHaveElementClass('is-active')

    await pressPanelChord({ ctrl: true, key: 'j' })
    await browser.waitUntil(async () => !(await pane.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: 'expected pane-files to hide after Ctrl+J',
    })
  })

  it('opens explorer with Ctrl/Cmd+Shift+E', async () => {
    await closeRightPanelIfOpen()
    await focusOutsideComposer()
    await pressPanelChord({ ctrl: true, shift: true, key: 'E' })
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Explorer"]')).toHaveElementClass('is-active')
  })

  it('opens terminal with Ctrl/Cmd+`', async () => {
    await closeRightPanelIfOpen()
    await focusOutsideComposer()
    await pressPanelChord({ ctrl: true, key: '`', code: 'Backquote' })
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Terminal"]')).toHaveElementClass('is-active')
    await $('.terminal-container .xterm').waitForExist({ timeout: 15_000 })
  })

  it('opens changes with Ctrl/Cmd+Shift+G', async () => {
    await closeRightPanelIfOpen()
    await focusOutsideComposer()
    await pressPanelChord({ ctrl: true, shift: true, key: 'G' })
    await $('#pane-files').waitForDisplayed({ timeout: 5_000 })
    await expect($('.right-panel-tab[aria-label="Changes"]')).toHaveElementClass('is-active')
    await $('#git-changes-host').waitForDisplayed({ timeout: 5_000 })
  })

  it('does not toggle the panel while typing in the composer', async () => {
    await closeRightPanelIfOpen()
    const pane = await $('#pane-files')
    const composer = await $('.prompt-input')
    await composer.click()
    await pressPanelChord({ ctrl: true, key: 'b' }, 'composer')
    await browser.waitUntil(async () => !(await pane.isDisplayed()), {
      timeout: 2_000,
      timeoutMsg: 'expected pane-files to stay hidden when Ctrl+B is pressed in composer',
    })
  })
})
