import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('titlebar panel overflow', () => {
  for (const width of [1200, 800, 600]) {
    it(`keeps every panel action reachable at ${width}px`, async () => {
      await browser.setWindowSize(width, 720)
      await browser.url('/?scenario=footer-compact')
      await $('#titlebar').waitForDisplayed()
      await browser.execute(() => {
        const editor = document.querySelector<HTMLElement>('#titlebar .open-in-editor')
        const label = document.querySelector('#titlebar .open-in-editor-label')
        if (!editor || !label) throw new Error('Missing editor fixture')
        editor.hidden = false
        label.textContent = 'Open in Visual Studio Code'
        const run = document.querySelector<HTMLElement>('#titlebar .titlebar-run-app')
        if (run) run.hidden = false
        const ssh = document.querySelector<HTMLElement>('#titlebar .workspace-ssh-target')
        if (ssh) {
          ssh.hidden = false
          ssh.textContent = 'developer@a-very-long-remote-development-host.example.com'
        }
      })
      await browser
        .waitUntil(
          async () =>
            browser.execute(() => {
              const buttons = [...document.querySelectorAll<HTMLElement>('#titlebar button')]
              return buttons
                .filter((button) => button.getBoundingClientRect().width > 0)
                .every((button) => {
                  const rect = button.getBoundingClientRect()
                  return rect.left >= 0 && rect.right <= window.innerWidth
                })
            }),
          { timeoutMsg: 'titlebar actions should fit within the viewport' },
        )
        .catch(async () => {
          const bounds = await browser.execute(() =>
            [...document.querySelectorAll<HTMLElement>('#titlebar button')]
              .filter((button) => button.getBoundingClientRect().width > 0)
              .map((button) => ({
                text: button.textContent,
                rect: button.getBoundingClientRect().toJSON(),
              })),
          )
          throw new Error(JSON.stringify(bounds))
        })
      const overflow = $('#titlebar .portrait-panel-overflow-trigger')
      const hiddenLabels = await browser.execute(() =>
        [...document.querySelectorAll('#titlebar [data-portrait-overflow]')].map((button) =>
          (button.querySelector('.titlebar-btn-label')?.textContent ?? button.textContent)?.trim(),
        ),
      )
      if (hiddenLabels.length) {
        await overflow.click()
        await expect($('#titlebar .portrait-panel-overflow-menu')).toBeDisplayed()
        const labels = await browser.execute(() =>
          [...document.querySelectorAll('#titlebar .portrait-panel-overflow-item')].map((button) =>
            button.textContent?.trim(),
          ),
        )
        expect(labels).toEqual(hiddenLabels)
        const geometry = await browser.execute(() => {
          const rect = document
            .querySelector('#titlebar .portrait-panel-overflow-menu')!
            .getBoundingClientRect()
          return {
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            viewport: window.innerWidth,
          }
        })
        expect(geometry.left).toBeGreaterThanOrEqual(0)
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport)
        expect(geometry.bottom).toBeLessThanOrEqual(720)
      }
      await saveAppScreenshot(`titlebar-overflow-${width}.png`, { width, height: 720 })
      if (hiddenLabels.includes('PRs')) {
        if (!(await $('#titlebar .portrait-panel-overflow-menu').isDisplayed()))
          await overflow.click()
        await $('#titlebar .portrait-panel-overflow-menu').$('button=PRs').click()
        await expect($('#pr-list-host')).toBeDisplayed()
      }
    })
  }
})
