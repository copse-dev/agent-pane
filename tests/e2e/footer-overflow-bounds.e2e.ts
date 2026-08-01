import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedDeveloperModeSetting, writeSeedConfig } from './helpers/seed-config.ts'
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

type PopupEdge = 'left' | 'right'

async function expectPopupGeometry(
  triggerSelector: string,
  popupSelector: string,
  edge: PopupEdge,
): Promise<void> {
  const geometry = await browser.execute(
    (triggerSelector, popupSelector, edge) => {
      const footer = document.querySelector<HTMLElement>('.input-footer')
      const trigger = document.querySelector<HTMLElement>(triggerSelector)
      const popup = document.querySelector<HTMLElement>(popupSelector)
      if (!footer || !trigger || !popup) return null
      const footerRect = footer.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const popupRect = popup.getBoundingClientRect()
      const previousPointerEvents = popup.style.pointerEvents
      popup.style.pointerEvents = 'auto'
      const topElement = document.elementsFromPoint(
        popupRect.left + popupRect.width / 2,
        popupRect.top + popupRect.height / 2,
      )[0]
      popup.style.pointerEvents = previousPointerEvents
      return {
        footerWidth: footerRect.width,
        popupWidth: popupRect.width,
        horizontalGap: Math.abs(
          edge === 'left' ? popupRect.left - triggerRect.left : popupRect.right - triggerRect.right,
        ),
        verticalGap: triggerRect.top - popupRect.bottom,
        contained: popupRect.left >= footerRect.left - 1 && popupRect.right <= footerRect.right + 1,
        paintedOnTop: topElement ? popup.contains(topElement) : false,
      }
    },
    triggerSelector,
    popupSelector,
    edge,
  )

  expect(geometry).not.toBeNull()
  expect(geometry?.popupWidth).toBeLessThan(geometry?.footerWidth ?? 0)
  expect(geometry?.horizontalGap).toBeLessThanOrEqual(1)
  expect(geometry?.verticalGap).toBeGreaterThanOrEqual(3)
  expect(geometry?.verticalGap).toBeLessThanOrEqual(5)
  expect(geometry?.contained).toBe(true)
  expect(geometry?.paintedOnTop).toBe(true)
}

describe('footer overflow menu bounds', () => {
  before(async () => {
    resetUserData()
    seedThread()
    // Four of the five overflow items are gated behind Developer mode. Without
    // this the menu holds only "Enable Guarded YOLO", which is both too short
    // to give the bounds assertions below anything to measure and not the menu
    // this spec was written against.
    seedDeveloperModeSetting(true)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps every menu edge inside a narrow composer', async function () {
    this.timeout(90_000)

    await $('.project-new-thread-btn').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('New Thread')

    const checkoutTrigger = $('.footer-checkout-btn')
    const checkoutMenu = $('.footer-checkout-menu')
    await expect(checkoutTrigger).toBeDisplayed()
    await checkoutTrigger.click()
    await expect(checkoutMenu).toBeDisplayed()
    await expectPopupGeometry('.footer-checkout-btn', '.footer-checkout-menu', 'left')
    await checkoutTrigger.click()
    await expect(checkoutMenu).not.toBeDisplayed()

    const branchTrigger = $('.footer-branch-host .branch-picker-trigger')
    const branchMenu = $('.footer-branch-host .branch-picker-menu')
    await branchTrigger.click()
    await expect(branchMenu).toBeDisplayed()
    await expectPopupGeometry(
      '.footer-branch-host .branch-picker-trigger',
      '.footer-branch-host .branch-picker-menu',
      'left',
    )
    await browser.keys('Escape')
    await expect(branchMenu).not.toBeDisplayed()

    const seededThread = $('.chat-row*=Footer overflow bounds')
    await seededThread.waitForExist({ timeout: 10_000 })
    await seededThread.click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Footer overflow bounds')

    await $('.footer-model-host .model-picker-trigger').click()
    await expect($('.footer-model-host .model-picker-menu')).toBeDisplayed()
    await expectPopupGeometry(
      '.footer-model-host .model-picker-trigger',
      '.footer-model-host .model-picker-menu',
      'left',
    )

    const modelPickerBounds = await browser.execute(() => {
      const footer = document.querySelector<HTMLElement>('.input-footer')
      const trigger = document.querySelector<HTMLElement>(
        '.footer-model-host .model-picker-trigger',
      )
      const menu = document.querySelector<HTMLElement>('.footer-model-host .model-picker-menu')
      if (!footer || !trigger || !menu) return null
      const footerRect = footer.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      return {
        footerWidth: footerRect.width,
        menuWidth: menuRect.width,
        anchorGap: Math.abs(menuRect.left - triggerRect.left),
        verticalGap: triggerRect.top - menuRect.bottom,
        contained: menuRect.left >= footerRect.left && menuRect.right <= footerRect.right,
      }
    })
    expect(modelPickerBounds).not.toBeNull()
    expect(modelPickerBounds?.menuWidth).toBeLessThanOrEqual(420)
    expect(modelPickerBounds?.menuWidth).toBeLessThan(modelPickerBounds?.footerWidth ?? 0)
    expect(modelPickerBounds?.anchorGap).toBeLessThanOrEqual(1)
    expect(modelPickerBounds?.verticalGap).toBeGreaterThanOrEqual(3)
    expect(modelPickerBounds?.verticalGap).toBeLessThanOrEqual(5)
    expect(modelPickerBounds?.contained).toBe(true)
    await saveAppScreenshot('footer-model-trigger-anchored.png')

    await browser.keys('Escape')
    await expect($('.footer-model-host .model-picker-menu')).not.toBeDisplayed()

    const contextWheel = $('.context-wheel')
    const contextPopover = $('.context-wheel-popover')
    await contextWheel.moveTo()
    await expect(contextPopover).toBeDisplayed()
    await expectPopupGeometry('.context-wheel', '.context-wheel-popover', 'right')
    await $('#pane-projects').moveTo({ xOffset: 8, yOffset: 8 })
    await expect(contextPopover).not.toBeDisplayed()

    await $('.footer-overflow-trigger').click()
    await expect($('.footer-overflow-menu')).toBeDisplayed()
    await expectPopupGeometry('.footer-overflow-trigger', '.footer-overflow-menu', 'right')
    const anchorStyles = await browser.execute(() => {
      const footer = document.querySelector<HTMLElement>('.input-footer')
      const trigger = document.querySelector<HTMLElement>('.footer-overflow-trigger')
      const menu = document.querySelector<HTMLElement>('.footer-overflow-menu')
      if (!footer || !trigger || !menu) return null
      return {
        supported: CSS.supports('position-anchor: --footer-overflow-trigger'),
        footerPosition: getComputedStyle(footer).position,
        footerIsContainingBlock: menu.offsetParent === footer,
        triggerAnchorName: getComputedStyle(trigger).getPropertyValue('anchor-name'),
        positionAnchor: getComputedStyle(menu).getPropertyValue('position-anchor'),
        inlineTransform: menu.style.transform,
      }
    })
    expect(anchorStyles).toEqual({
      supported: true,
      footerPosition: 'relative',
      footerIsContainingBlock: true,
      triggerAnchorName: '--footer-overflow-trigger',
      positionAnchor: '--footer-overflow-trigger',
      inlineTransform: '',
    })

    const footerPopupAnchors = await browser.execute(() => {
      const selectors = [
        ['.footer-model-host .model-picker-trigger', '.footer-model-host .model-picker-menu'],
        ['.footer-checkout-btn', '.footer-checkout-menu'],
        ['.footer-branch-host .branch-picker-trigger', '.footer-branch-host .branch-picker-menu'],
        ['.footer-overflow-trigger', '.footer-overflow-menu'],
        ['.context-wheel', '.context-wheel-popover'],
      ]
      return selectors.map(([triggerSelector, popupSelector]) => {
        if (!triggerSelector || !popupSelector) return null
        const trigger = document.querySelector<HTMLElement>(triggerSelector)
        const popup = document.querySelector<HTMLElement>(popupSelector)
        if (!trigger || !popup) return null
        return {
          anchorName: getComputedStyle(trigger).getPropertyValue('anchor-name'),
          positionAnchor: getComputedStyle(popup).getPropertyValue('position-anchor'),
        }
      })
    })
    expect(footerPopupAnchors).toEqual([
      { anchorName: '--footer-model-trigger', positionAnchor: '--footer-model-trigger' },
      { anchorName: '--footer-checkout-trigger', positionAnchor: '--footer-checkout-trigger' },
      { anchorName: '--footer-branch-trigger', positionAnchor: '--footer-branch-trigger' },
      { anchorName: '--footer-overflow-trigger', positionAnchor: '--footer-overflow-trigger' },
      { anchorName: '--footer-context-trigger', positionAnchor: '--footer-context-trigger' },
    ])

    const anchoredBounds = await browser.execute(() => {
      const trigger = document.querySelector<HTMLElement>('.footer-overflow-trigger')
      const menu = document.querySelector<HTMLElement>('.footer-overflow-menu')
      if (!trigger || !menu) return null
      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      return {
        horizontalGap: Math.abs(menuRect.right - triggerRect.right),
        verticalGap: triggerRect.top - menuRect.bottom,
      }
    })
    expect(anchoredBounds).not.toBeNull()
    expect(anchoredBounds?.horizontalGap).toBeLessThanOrEqual(1)
    expect(anchoredBounds?.verticalGap).toBeGreaterThanOrEqual(3)
    expect(anchoredBounds?.verticalGap).toBeLessThanOrEqual(5)
    await saveAppScreenshot('footer-overflow-trigger-anchored.png')

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
    // Guarded YOLO + Copy thread ID + both exports + Share trace. The roster is
    // pinned by label in input-bar.test.ts; keep the two in step when it grows.
    await expect($$('.footer-overflow-item')).toBeElementsArrayOfSize(5)

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

    // A real resizer pointerdown occurs outside this popup and dismisses it
    // before the pane changes width. Mirror that reachable sequence, then
    // reopen at the minimum width to prove the footer cap contains the menu.
    await browser.keys('Escape')
    await expect($('.footer-overflow-menu')).not.toBeDisplayed()
    await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      if (!pane) return
      pane.style.width = '220px'
      pane.style.maxWidth = '220px'
    })
    await $('.footer-overflow-trigger').click()
    await expect($('.footer-overflow-menu')).toBeDisplayed()
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
      { timeoutMsg: 'expected the positioned footer to contain the menu at extreme width' },
    )

    await browser.keys('Escape')
    await expect($('.footer-overflow-menu')).not.toBeDisplayed()
    await $('.footer-model-host .model-picker-trigger').click()
    await expect($('.footer-model-host .model-picker-menu')).toBeDisplayed()
    const compactModelBounds = await browser.execute(() => {
      const footer = document.querySelector<HTMLElement>('.input-footer')
      const menu = document.querySelector<HTMLElement>('.footer-model-host .model-picker-menu')
      if (!footer || !menu) return null
      const footerRect = footer.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const topElement = document.elementsFromPoint(
        menuRect.left + menuRect.width / 2,
        menuRect.top + menuRect.height / 2,
      )[0]
      return {
        leftGap: Math.abs(menuRect.left - footerRect.left),
        contained: menuRect.right <= footerRect.right + 1,
        paintedOnTop: topElement ? menu.contains(topElement) : false,
      }
    })
    expect(compactModelBounds).not.toBeNull()
    expect(compactModelBounds?.leftGap).toBeLessThanOrEqual(1)
    expect(compactModelBounds?.contained).toBe(true)
    expect(compactModelBounds?.paintedOnTop).toBe(true)
  })
})
