import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// Slice 7 of docs/plans/new-thread-activity-screen.md: the Activity home above a
// bottom panel and in a chat pane of about 360 px, in both themes. The prototype
// (prototypes/new-thread-activity.html?panel=terminal&pos=bottom) is the
// reference. The spec asserts what must hold in each arrangement: the first group
// heading and the selected row stay in view, Approve stays inside the card, the
// card never reaches the composer, and nothing spills sideways.

interface PanelProbe {
  paneWidth: number
  bottomPanel: boolean
  listScrollTop: number
  headingInList: boolean
  rowInList: boolean
  approveInsideCard: boolean
  cardBottom: number
  captionBottom: number
  composerTop: number
  overflowsSideways: boolean
}

async function probe(): Promise<PanelProbe | null> {
  return browser.execute(() => {
    const root = document.getElementById('activity-home')
    const card = root?.querySelector('.activity-panel-body')
    const list = root?.querySelector('.activity-list')
    const heading = root?.querySelector('[data-group="needs-you"] .activity-group-title')
    const row = root?.querySelector('.activity-row[data-selected="true"]')
    const approve = root?.querySelector('.activity-approve')
    const caption = root?.querySelector('.activity-home-caption')
    const input = document.getElementById('input-bar')
    const pane = document.getElementById('pane-chat')
    if (!root || !card || !list || !heading || !row || !approve || !caption || !input || !pane)
      return null
    const frame = list.getBoundingClientRect()
    const cardBox = card.getBoundingClientRect()
    const approveBox = approve.getBoundingClientRect()
    const within = (box: DOMRect): boolean => box.top >= frame.top && box.bottom <= frame.bottom
    return {
      paneWidth: Math.round(pane.getBoundingClientRect().width),
      bottomPanel:
        document.getElementById('body')?.classList.contains('is-right-panel-horizontal') === true,
      listScrollTop: list.scrollTop,
      headingInList: within(heading.getBoundingClientRect()),
      rowInList: within(row.getBoundingClientRect()),
      approveInsideCard: approveBox.top >= cardBox.top && approveBox.bottom <= cardBox.bottom + 1,
      cardBottom: cardBox.bottom,
      captionBottom: caption.getBoundingClientRect().bottom,
      composerTop: input.getBoundingClientRect().top,
      overflowsSideways: root.scrollWidth > root.clientWidth,
    }
  })
}

async function resize(width: number, height: number): Promise<void> {
  const frame = await browser.execute(() => ({
    width: window.outerWidth - window.innerWidth,
    height: window.outerHeight - window.innerHeight,
  }))
  await browser.setWindowSize(width + frame.width, height + frame.height)
}

async function openHome(): Promise<void> {
  await browser.url('about:blank')
  await browser.url('/?scenario=activity-home')
  await $(
    '#activity-home .activity-row[data-state="needs-approval"][data-selected="true"]',
  ).waitForExist({ timeout: 30_000 })
  await $('#activity-home .activity-approve').waitForEnabled({ timeout: 5_000 })
  // The fixture's approval lands a tick after the first draw; let the list settle.
  await browser.execute(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function setTheme(theme: 'dark' | 'light'): Promise<void> {
  await browser.execute((value) => {
    document.documentElement.dataset.theme = value
  }, theme)
}

function expectArranged(result: PanelProbe | null): asserts result is PanelProbe {
  expect(result).not.toBeNull()
  if (!result) throw new Error('Missing Activity home elements')
  // A list resting at the top stays there when the approval arrives above its
  // other rows, so the heading and the selected request are what the user sees.
  expect(result.listScrollTop).toBe(0)
  expect(result.headingInList).toBe(true)
  expect(result.rowInList).toBe(true)
  expect(result.approveInsideCard).toBe(true)
  // The caption sits between the card and the composer, so it is clear of both.
  expect(result.cardBottom).toBeLessThanOrEqual(result.captionBottom + 1)
  expect(result.captionBottom).toBeLessThanOrEqual(result.composerTop + 1)
  expect(result.overflowsSideways).toBe(false)
}

describe('Activity home beside and above panels', () => {
  afterEach(async () => {
    await setTheme('dark')
  })

  after(async () => {
    await resize(1280, 800)
  })

  it('shows the first group and Approve above a bottom panel', async () => {
    await resize(700, 1000)
    await openHome()
    await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
    await $('#pane-files').waitForDisplayed()
    await browser.waitUntil(async () => (await probe())?.bottomPanel === true, {
      timeout: 10_000,
      timeoutMsg: 'a portrait window must stack the panel below the chat',
    })
    expectArranged(await probe())
    await saveAppScreenshot('activity-home-bottom-panel.png')
    await setTheme('light')
    await saveAppScreenshot('activity-home-bottom-panel-light.png')
  })

  it('shows the first group and Approve in a chat pane of about 360 px', async () => {
    await resize(1100, 700)
    await openHome()
    await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
    await $('#pane-files').waitForDisplayed()
    const result = await probe()
    expectArranged(result)
    expect(result.bottomPanel).toBe(false)
    expect(result.paneWidth).toBeLessThanOrEqual(400)
    await saveAppScreenshot('activity-home-narrow-pane.png')
    await setTheme('light')
    await saveAppScreenshot('activity-home-narrow-pane-light.png')
  })
  it('gives the list the whole card when every group is folded', async () => {
    await resize(1280, 800)
    await browser.url('about:blank')
    await browser.url('/?scenario=sidebar-thread-sort')
    await $('#activity-home .activity-group[data-group="working"]').waitForExist({
      timeout: 30_000,
    })
    const card = await browser.execute(() => {
      const body = document.querySelector('#activity-home .activity-panel-body')
      const list = document.querySelector('#activity-home .activity-list')
      const detail = document.querySelector('#activity-home .activity-detail')
      if (!body || !list || !detail) return null
      return {
        detailHidden: detail instanceof HTMLElement && detail.hidden,
        rows: document.querySelectorAll('#activity-home .activity-row').length,
        listWidth: list.getBoundingClientRect().width,
        bodyWidth: body.getBoundingClientRect().width,
      }
    })
    expect(card).not.toBeNull()
    if (!card) throw new Error('Missing Activity home card')
    expect(card.rows).toBe(0)
    expect(card.detailHidden).toBe(true)
    expect(card.listWidth).toBeGreaterThanOrEqual(card.bodyWidth - 2)
    await saveAppScreenshot('activity-home-folded.png')
  })
})
