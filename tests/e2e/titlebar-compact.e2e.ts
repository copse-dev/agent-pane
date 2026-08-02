import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'

describe('compact titlebar', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    await $('#titlebar').waitForDisplayed({ timeout: 30_000 })
  })

  it('compacts before controls overflow and preserves a draggable gap', async () => {
    await browser.execute(() => {
      const app = document.getElementById('app')
      const editor = document.querySelector<HTMLElement>('.open-in-editor')
      const editorLabel = document.querySelector<HTMLElement>('.open-in-editor-label')
      const workspaceName = document.querySelector<HTMLElement>('.workspace-name')
      const branch = document.querySelector<HTMLElement>('.workspace-branch')
      if (!app || !editor || !editorLabel || !workspaceName || !branch) {
        throw new Error('Missing titlebar fixture element')
      }
      const onboarding = document.getElementById('onboarding-dialog')
      if (onboarding) onboarding.hidden = true
      app.style.width = '1024px'
      app.style.maxWidth = '1024px'
      app.style.boxSizing = 'border-box'
      editor.removeAttribute('hidden')
      editorLabel.textContent = 'Open in Terminal'
      workspaceName.textContent = 'agent-pane'
      branch.removeAttribute('hidden')
      branch.textContent = 'copse/settings-polish'
      for (const selector of ['[aria-label="Open memories"]', '[aria-label="Open roadmap"]']) {
        const button = document.querySelector<HTMLElement>(`#titlebar ${selector}`)
        button?.removeAttribute('hidden')
        button?.removeAttribute('data-experimental-hidden')
      }
      window.dispatchEvent(new Event('resize'))
    })

    await browser.waitUntil(
      async () => (await $('#titlebar').getAttribute('class')).includes('is-titlebar-compact'),
      { timeout: 5_000, timeoutMsg: 'expected the narrow titlebar to compact' },
    )

    const layout = await browser.execute(() => {
      const titlebar = document.getElementById('titlebar')!
      const dragRegion = document.querySelector<HTMLElement>('.titlebar-drag')!
      const controls = document.querySelector<HTMLElement>('.titlebar-panel-controls')!
      const titlebarRect = titlebar.getBoundingClientRect()
      const dragRect = dragRegion.getBoundingClientRect()
      const controlsRect = controls.getBoundingClientRect()
      const displayedLabels = Array.from(
        titlebar.querySelectorAll<HTMLElement>('.titlebar-compact-icon .titlebar-btn-label'),
      ).filter((label) => getComputedStyle(label).display !== 'none').length
      return {
        clientWidth: titlebar.clientWidth,
        scrollWidth: titlebar.scrollWidth,
        dragWidth: dragRect.width,
        controlsRight: controlsRect.right,
        titlebarRight: titlebarRect.right,
        displayedLabels,
      }
    })
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
    expect(layout.controlsRight).toBeLessThanOrEqual(layout.titlebarRight)
    expect(layout.dragWidth).toBeGreaterThanOrEqual(16)
    expect(layout.displayedLabels).toBe(0)

    await $('#titlebar').saveScreenshot(join(E2E_SCREENSHOT_DIR, 'titlebar-compact-width.png'))
  })
})
