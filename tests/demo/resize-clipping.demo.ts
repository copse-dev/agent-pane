import { $, browser, expect } from '@wdio/globals'
import {
  prepareE2eScreenshot,
  prepareThreePaneScreenshot,
  saveAppScreenshot,
} from '../e2e/helpers/screenshot.ts'

describe('app frame after resizing', () => {
  it('keeps the frame anchored when overflowing controls are scrolled into view', async () => {
    await browser.url('/?scenario=chat-layout-styling')
    await $('#titlebar').waitForDisplayed({ timeout: 30_000 })
    await $('[aria-label="Toggle right panel"]').click()
    await $('#pane-files').waitForDisplayed()
    await browser.setWindowSize(760, 900)
    // Capture preparation must not create another scrollable app root.
    await prepareE2eScreenshot({ width: 760, height: 800 })

    const offsets = await browser.execute(() => {
      const app = document.getElementById('app')
      if (!app) throw new Error('Missing app capture subject')
      const body = document.getElementById('body')
      if (!body) throw new Error('Missing body capture subject')
      const titlebar = document.getElementById('titlebar')
      if (!titlebar) throw new Error('Missing titlebar capture subject')
      for (const button of titlebar.querySelectorAll<HTMLElement>('[data-experimental-hidden]')) {
        button.removeAttribute('hidden')
        button.removeAttribute('data-experimental-hidden')
      }
      const editor = titlebar.querySelector<HTMLElement>('.open-in-editor')
      if (!editor) throw new Error('Missing editor capture subject')
      editor.removeAttribute('hidden')
      const editorLabel = titlebar.querySelector<HTMLElement>('.open-in-editor-label')
      if (!editorLabel) throw new Error('Missing editor label')
      editorLabel.textContent = 'Open in Terminal'
      // Recreate the transient measurement frame: all panel actions are revealed
      // and left-aligned before compact/overflow planning runs. Merely removing
      // the compact class leaves the previous overflow plan hiding its buttons.
      // Focus/scroll requests during this frame must not pan the app.
      titlebar.classList.remove('is-titlebar-compact')
      const panelControls = titlebar.querySelector<HTMLElement>('.titlebar-panel-controls')
      if (!panelControls) throw new Error('Missing titlebar panel controls')
      const alignment = panelControls.style.justifyContent
      panelControls.style.justifyContent = 'flex-start'
      for (const button of panelControls.querySelectorAll('[data-portrait-overflow]')) {
        button.removeAttribute('data-portrait-overflow')
      }
      const controls = [
        ...titlebar.querySelectorAll<HTMLElement>('.titlebar-panel-controls button'),
      ]
      const control = controls.filter((button) => button.checkVisibility()).at(-1)
      if (!control) throw new Error('Missing control capture subject')
      control.focus()
      control.scrollIntoView({ block: 'nearest', inline: 'end' })
      const offsets = [document.documentElement, document.body, app, body].map((node) => ({
        id: node.id || node.tagName,
        left: node.getBoundingClientRect().left,
        scrollLeft: node.scrollLeft,
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }))
      panelControls.style.justifyContent = alignment
      window.dispatchEvent(new Event('resize'))
      return offsets
    })
    const page = offsets.find((node) => node.id === 'app')
    if (!page) throw new Error('Missing page capture subject')
    expect(page.scrollWidth).toBeGreaterThan(page.width)
    expect(offsets.map((node) => node.scrollLeft)).toEqual([0, 0, 0, 0])
    expect(offsets.map((node) => node.left)).toEqual([0, 0, 0, 0])
    await expect($('#titlebar')).toHaveElementClass('is-titlebar-compact')
    const composer = await browser.execute(() => {
      const editor = document.querySelector<HTMLElement>('.prompt-input')
      const send = document.querySelector<HTMLElement>('.submit-row')
      if (!editor || !send) throw new Error('Missing composer layout')
      const bounds = editor.getBoundingClientRect()
      const style = getComputedStyle(editor)
      return {
        textWidth: bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        editorBottom: bounds.bottom,
        actionsTop: send.getBoundingClientRect().top,
        footerFits: [...document.querySelectorAll<HTMLElement>('.input-footer button')]
          .filter((button) => button.checkVisibility())
          .every((button) => {
            const rect = button.getBoundingClientRect()
            const footer = button.closest('.input-footer')?.getBoundingClientRect()
            return !!footer && rect.left >= footer.left && rect.right <= footer.right
          }),
      }
    })
    expect(composer.textWidth).toBeGreaterThan(90)
    expect(composer.actionsTop).toBeGreaterThanOrEqual(composer.editorBottom)
    expect(composer.footerFits).toBe(true)
    await saveAppScreenshot('resize-clipping-narrow.png', { width: 760, height: 800 })

    await browser.execute(() => {
      const app = document.getElementById('app')
      if (!app) throw new Error('Missing app capture subject')
      app.style.removeProperty('width')
      app.style.removeProperty('height')
    })
    await browser.setWindowSize(1280, 900)
    const restored = await browser.execute(() => {
      const appElement = document.getElementById('app')
      if (!appElement) throw new Error('Missing app capture element')
      const app = appElement.getBoundingClientRect()
      const projectsElement = document.getElementById('pane-projects')
      if (!projectsElement) throw new Error('Missing projects capture element')
      const projects = projectsElement.getBoundingClientRect()
      return {
        appLeft: app.left,
        appRight: app.right,
        projectsLeft: projects.left,
        width: innerWidth,
      }
    })
    expect(restored.appLeft).toBe(0)
    expect(restored.projectsLeft).toBe(0)
    expect(restored.appRight).toBe(restored.width)
    await saveAppScreenshot('resize-clipping-restored.png')
  })

  it('clamps the three-pane capture to the actual window', async () => {
    await browser.url('/?scenario=chat-layout-styling')
    await $('#titlebar').waitForDisplayed({ timeout: 30_000 })
    await $('[aria-label="Toggle right panel"]').click()
    await $('#pane-files').waitForDisplayed()
    await browser.setWindowSize(1000, 900)
    await prepareThreePaneScreenshot()
    const geometry = await browser.execute(() => {
      const app = document.getElementById('app')
      if (!app) throw new Error('Missing app capture subject')
      app.scrollLeft = 300
      return {
        width: app.getBoundingClientRect().width,
        viewport: innerWidth,
        scrollLeft: app.scrollLeft,
      }
    })
    expect(geometry.width).toBe(geometry.viewport)
    expect(geometry.scrollLeft).toBe(0)
    await browser.execute(() => {
      const app = document.getElementById('app')
      if (!app) throw new Error('Missing app capture subject')
      for (const property of ['width', 'height', 'overflow', 'box-sizing']) {
        app.style.removeProperty(property)
      }
    })
    await saveAppScreenshot('resize-clipping-three-pane.png', { width: 1000, height: 800 })
    const afterCapture = await browser.execute(() => {
      const app = document.getElementById('app')
      if (!app) throw new Error('Missing app capture subject')
      return ['width', 'height', 'overflow', 'box-sizing'].map((property) =>
        app.style.getPropertyValue(property),
      )
    })
    expect(afterCapture).toEqual(['', '', '', ''])
  })
})
