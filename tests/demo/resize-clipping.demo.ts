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
      const app = document.getElementById('app')!
      const body = document.getElementById('body')!
      const titlebar = document.getElementById('titlebar')!
      for (const button of titlebar.querySelectorAll<HTMLElement>('[data-experimental-hidden]')) {
        button.removeAttribute('hidden')
        button.removeAttribute('data-experimental-hidden')
      }
      const editor = titlebar.querySelector<HTMLElement>('.open-in-editor')!
      editor.removeAttribute('hidden')
      titlebar.querySelector<HTMLElement>('.open-in-editor-label')!.textContent = 'Open in Terminal'
      // A resize can make the full titlebar overflow before its next-frame
      // compact measurement runs. Focus/scroll requests must not pan the app.
      titlebar.classList.remove('is-titlebar-compact')
      const controls = [
        ...titlebar.querySelectorAll<HTMLElement>('.titlebar-panel-controls button'),
      ]
      const control = controls.filter((button) => button.checkVisibility()).at(-1)!
      control.focus()
      control.scrollIntoView({ block: 'nearest', inline: 'end' })
      return [document.documentElement, document.body, app, body].map((node) => ({
        id: node.id || node.tagName,
        left: node.getBoundingClientRect().left,
        scrollLeft: node.scrollLeft,
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }))
    })
    const page = offsets.find((node) => node.id === 'app')!
    expect(page.scrollWidth).toBeGreaterThan(page.width)
    expect(offsets.map((node) => node.scrollLeft)).toEqual([0, 0, 0, 0])
    expect(offsets.map((node) => node.left)).toEqual([0, 0, 0, 0])
    await expect($('#titlebar')).toHaveElementClass('is-titlebar-compact')
    await saveAppScreenshot('resize-clipping-narrow.png', { width: 760, height: 800 })

    await browser.execute(() => {
      const app = document.getElementById('app')!
      app.style.removeProperty('width')
      app.style.removeProperty('height')
    })
    await browser.setWindowSize(1280, 900)
    const restored = await browser.execute(() => {
      const app = document.getElementById('app')!.getBoundingClientRect()
      const projects = document.getElementById('pane-projects')!.getBoundingClientRect()
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
      const app = document.getElementById('app')!
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
      const app = document.getElementById('app')!
      for (const property of ['width', 'height', 'overflow', 'box-sizing']) {
        app.style.removeProperty(property)
      }
    })
    await saveAppScreenshot('resize-clipping-three-pane.png', { width: 1000, height: 800 })
    const afterCapture = await browser.execute(() => {
      const app = document.getElementById('app')!
      return ['width', 'height', 'overflow', 'box-sizing'].map((property) =>
        app.style.getPropertyValue(property),
      )
    })
    expect(afterCapture).toEqual(['', '', '', ''])
  })
})
