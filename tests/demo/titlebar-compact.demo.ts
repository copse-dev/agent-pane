import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('browser-hosted compact titlebar geometry', () => {
  before(async () => {
    await browser.url('/?scenario=chat-layout-styling')
    await $('#titlebar').waitForDisplayed({ timeout: 30_000 })
  })

  it('keeps blank titlebar space native while controls remain clickable', async () => {
    const regions = await browser.execute(() => {
      const titlebar = document.getElementById('titlebar')
      const left = titlebar?.querySelector<HTMLElement>('.titlebar-left')
      const controls = titlebar?.querySelector<HTMLElement>('.titlebar-panel-controls')
      if (!titlebar || !left || !controls) return null
      const buttons = [...titlebar.querySelectorAll('button')].filter(
        (button) => button.getBoundingClientRect().width > 0,
      )
      const controlsRect = controls.getBoundingClientRect()
      const firstControl = buttons.find((button) => controls.contains(button))
      if (!firstControl) return null
      const firstButton = firstControl.getBoundingClientRect()
      // Electron subtracts every no-drag box from the native region, including
      // the flexible container's empty space. Chrome cannot exercise OS double
      // clicks, but it can catch the geometry and computed-style regression.
      return {
        titlebar: getComputedStyle(titlebar).getPropertyValue('-webkit-app-region'),
        left: getComputedStyle(left).getPropertyValue('-webkit-app-region'),
        controls: getComputedStyle(controls).getPropertyValue('-webkit-app-region'),
        buttons: buttons.map((button) =>
          getComputedStyle(button).getPropertyValue('-webkit-app-region'),
        ),
        blankWidth: firstButton.left - controlsRect.left,
      }
    })
    if (!regions) throw new Error('the titlebar regions must render')
    expect(regions.titlebar).toBe('drag')
    expect(regions.left).not.toBe('no-drag')
    expect(regions.controls).not.toBe('no-drag')
    expect(regions.buttons.length).toBeGreaterThan(0)
    expect(regions.buttons.every((region) => region === 'no-drag')).toBe(true)
    expect(regions.blankWidth).toBeGreaterThan(16)

    const sidebar = $('#titlebar [aria-label="Toggle sidebar"]')
    const initiallyPressed = await sidebar.getAttribute('aria-pressed')
    if (initiallyPressed === null) throw new Error('the sidebar toggle must expose aria-pressed')
    await sidebar.click()
    await expect(sidebar).toHaveAttribute('aria-pressed', String(initiallyPressed !== 'true'))
    await sidebar.click()
    await expect(sidebar).toHaveAttribute('aria-pressed', initiallyPressed)
    await saveElementScreenshot('#titlebar', 'titlebar-native-regions.png')
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
      async () =>
        (await $('#titlebar').getAttribute('class'))?.includes('is-titlebar-compact') === true,
      { timeout: 5_000, timeoutMsg: 'expected the narrow titlebar to compact' },
    )

    const layout = await browser.execute(() => {
      const titlebar = document.getElementById('titlebar')
      if (titlebar == null) throw new Error('Missing titlebar in test fixture')
      const dragRegion = document.querySelector<HTMLElement>('.titlebar-drag')
      if (dragRegion == null) throw new Error('Missing dragRegion in test fixture')
      const controls = document.querySelector<HTMLElement>('.titlebar-panel-controls')
      if (controls == null) throw new Error('Missing controls in test fixture')
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

    await saveElementScreenshot('#titlebar', 'titlebar-compact-width.png')
  })
})
