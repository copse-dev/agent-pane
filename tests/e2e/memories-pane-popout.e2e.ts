import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'

// The Memories pane is gated on the experimental okfMemoriesEnabled setting, so
// unlike the other right-panel panes it needs the toggle seeded on and a couple
// of notes to render. This spec seeds both, opens the pane, and pops it out so
// the list + inline editor get a committed reference screenshot.
describe('Memories pane pop-out', () => {
  let mainHandle: string

  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-memories-popout', { okfMemoriesEnabled: true })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    mainHandle = (await browser.getWindowHandles())[0]
  })

  after(async () => {
    try {
      await browser.switchToWindow(mainHandle)
    } catch {
      // session already gone — nothing to do
    }
    resetUserData()
  })

  it('detaches the memories pane into its own window', async function () {
    this.timeout(180_000)

    // Seed a couple of memories through the real IPC surface so both the list
    // and (after selecting a row) the editor column have content to render.
    await browser.execute(async () => {
      const api = (
        window as unknown as {
          api: { memories: { create: (t: string, b: string, tags?: string[]) => Promise<unknown> } }
        }
      ).api
      await api.memories.create('Build command', 'Run `npm run build` before shipping a release.', [
        'ops',
      ])
      await api.memories.create(
        'Where the API key lives',
        'Stored in `.env` at the repo root; never commit it.',
        ['config', 'security'],
      )
    })

    // The titlebar Memories button is revealed by the seeded setting.
    const openBtn = await $('.titlebar-panel-controls [aria-label="Open memories"]')
    await openBtn.waitForDisplayed({ timeout: 20_000 })
    await openBtn.click()
    await $('#memories-host').waitForDisplayed({ timeout: 20_000 })
    await browser.waitUntil(async () => (await $$('#memories-host .memories-row')).length >= 2, {
      timeout: 20_000,
      timeoutMsg: 'expected the seeded memories to render in the docked pane',
    })

    // Detach via the pane header's pop-out control.
    const popoutBtn = await $('#memories-host .pane-popout-btn')
    await popoutBtn.waitForClickable({ timeout: 10_000 })
    const before = await browser.getWindowHandles()
    await popoutBtn.click()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 15_000,
      timeoutMsg: 'expected a pop-out window for memories',
    })
    const popoutHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h))
    expect(popoutHandle).toBeDefined()

    // The detached window renders only the memories pane; app chrome is collapsed
    // and the (now redundant) in-panel pop-out control is hidden.
    await browser.switchToWindow(popoutHandle as string)
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.documentElement.getAttribute('data-popout-mode') === 'memories',
        )) === true,
      { timeout: 20_000, timeoutMsg: 'popout window did not boot in memories mode' },
    )
    await browser.waitUntil(async () => (await $$('.memories-row')).length >= 2, {
      timeout: 30_000,
      timeoutMsg: 'expected the popped-out memories list to load its own data',
    })
    await expect(await $('#pane-files')).toBeDisplayed()
    await expect(await $('#titlebar')).not.toBeDisplayed()
    await expect(await $('#pane-projects')).not.toBeDisplayed()
    await expect(await $('#pane-chat')).not.toBeDisplayed()
    await expect(await $('.pane-popout-btn')).not.toBeDisplayed()

    // Select the first note so the editor column is populated in the shot.
    await $('.memories-row').click()
    await browser.waitUntil(
      async () => {
        const value = await $('.memories-title-input').getValue()
        return typeof value === 'string' && value.length > 0
      },
      { timeout: 10_000, timeoutMsg: 'expected the editor to load the selected memory' },
    )

    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'pane-popout-memories.png'))

    try {
      await browser.closeWindow()
    } catch {
      // leave it for session teardown
    }
    await browser.switchToWindow(mainHandle)
  })
})
