import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-footer-overflow-bounds'
const THREAD_ID = 'e2e-footer-overflow-bounds-thread'

function seedThread(): void {
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    activeThreadId: THREAD_ID,
    [`threads:${PROJECT_ID}`]: [
      {
        id: THREAD_ID,
        title: 'Footer overflow bounds',
        status: 'idle',
        gitBranch: 'main',
        messages: [
          {
            id: 'footer-overflow-user-message',
            role: 'user',
            content: 'Keep the footer overflow menu inside the composer.',
            toolCalls: [],
            createdAt: now,
          },
        ],
        usage: { inputTokens: 1_000, outputTokens: 500 },
        createdAt: now,
        updatedAt: now,
      },
    ],
  })
}

describe('footer overflow menu bounds', () => {
  before(async () => {
    resetUserData()
    seedThread()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps every menu edge inside a narrow composer', async () => {
    await $('.footer-overflow-trigger').click()
    await expect($('.footer-overflow-menu')).toBeDisplayed()
    const anchorStyles = await browser.execute(() => {
      const trigger = document.querySelector<HTMLElement>('.footer-overflow-trigger')
      const boundary = document.querySelector<HTMLElement>('.footer-overflow-boundary')
      const menu = document.querySelector<HTMLElement>('.footer-overflow-menu')
      if (!trigger || !boundary || !menu) return null
      return {
        supported: CSS.supports('position-anchor: --footer-overflow-trigger'),
        boundaryAnchorName: getComputedStyle(boundary).getPropertyValue('anchor-name'),
        triggerAnchorName: getComputedStyle(trigger).getPropertyValue('anchor-name'),
        positionAnchor: getComputedStyle(menu).getPropertyValue('position-anchor'),
        inlineTransform: menu.style.transform,
      }
    })
    expect(anchorStyles).toEqual({
      supported: true,
      boundaryAnchorName: '--footer-overflow-boundary',
      triggerAnchorName: '--footer-overflow-trigger',
      positionAnchor: '--footer-overflow-trigger',
      inlineTransform: '',
    })

    await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      if (!pane) return
      pane.style.flex = '0 0 auto'
      pane.style.width = '360px'
      pane.style.maxWidth = '360px'
    })
    await browser.waitUntil(
      async () => (await $('.input-footer').getAttribute('class'))?.includes('is-compact') ?? false,
      { timeoutMsg: 'expected the narrow composer footer to enter compact layout' },
    )
    await expect($$('.footer-overflow-item')).toBeElementsArrayOfSize(4)

    await browser.waitUntil(
      async () => {
        const contained = await browser.execute(() => {
          const footer = document.querySelector<HTMLElement>('.input-footer')
          const menu = document.querySelector<HTMLElement>('.footer-overflow-menu')
          if (!footer || !menu) return false
          const footerRect = footer.getBoundingClientRect()
          const menuRect = menu.getBoundingClientRect()
          return menuRect.left >= footerRect.left && menuRect.right <= footerRect.right
        })
        return contained
      },
      { timeoutMsg: 'expected the open menu to move inside the resized composer' },
    )

    const bounds = await browser.execute(() => {
      const footer = document.querySelector<HTMLElement>('.input-footer')
      const menu = document.querySelector<HTMLElement>('.footer-overflow-menu')
      if (!footer || !menu) return null
      const footerRect = footer.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      return {
        footerLeft: footerRect.left,
        footerRight: footerRect.right,
        menuLeft: menuRect.left,
        menuRight: menuRect.right,
      }
    })
    expect(bounds).not.toBeNull()
    expect(bounds?.menuLeft).toBeGreaterThanOrEqual(bounds?.footerLeft ?? Number.POSITIVE_INFINITY)
    expect(bounds?.menuRight).toBeLessThanOrEqual(bounds?.footerRight ?? Number.NEGATIVE_INFINITY)

    // Resizing can move the context wheel under the pointer that clicked the
    // overflow trigger. Clear that incidental hover before the visual capture.
    await $('#pane-projects').moveTo({ xOffset: 8, yOffset: 8 })
    await expect($('.context-wheel-popover')).not.toBeDisplayed()
    await saveAppScreenshot('footer-overflow-bounded.png')

    // Make the menu's natural width exceed the footer. The boundary anchor's
    // width cap should shrink it and keep both horizontal edges contained.
    await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      if (!pane) return
      pane.style.width = '220px'
      pane.style.maxWidth = '220px'
    })
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          const footer = document.querySelector<HTMLElement>('.input-footer')
          const menu = document.querySelector<HTMLElement>('.footer-overflow-menu')
          if (!footer || !menu) return false
          const footerRect = footer.getBoundingClientRect()
          const menuRect = menu.getBoundingClientRect()
          return (
            Math.abs(menuRect.left - footerRect.left) < 1 && menuRect.right <= footerRect.right + 1
          )
        })
      },
      { timeoutMsg: 'expected the boundary anchor to contain the menu at extreme width' },
    )
  })
})
