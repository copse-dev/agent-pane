import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// Toggling between the concise and full view — one turn at a time from its
// footer, or everywhere from Settings — must not move what the reader is looking
// at or drop their text selection. Runs against the five-turn concise fixture.

const TURN_3_PROMPT = 'concise-multi-user-3'
// Above the turn being toggled, so the selection's own reply popover stays clear of its footer.
const SELECTED_REPLY = 'concise-multi-reply-2-1'

async function openScenario(): Promise<void> {
  await browser.url('/?scenario=concise-thread-multi')
  await $('.concise-turn-footer').waitForDisplayed()
  await browser.pause(300)
}

/** Distance from the transcript's top edge to the element, in CSS pixels. */
async function offsetFromListTop(selector: string): Promise<number> {
  return browser.execute((sel) => {
    const list = document.querySelector('.messages-list')!
    const node = document.querySelector(sel)!
    return Math.round(node.getBoundingClientRect().top - list.getBoundingClientRect().top)
  }, selector)
}

async function visibleToolCards(): Promise<number> {
  return browser.execute(
    () =>
      [...document.querySelectorAll('.messages-list .tool-card')].filter(
        (card) => card instanceof HTMLElement && card.checkVisibility(),
      ).length,
  )
}

async function selectText(messageId: string): Promise<string> {
  return browser.execute((id) => {
    const text = document.querySelector(`[data-message-id="${id}"] .message-text`)!
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  }, messageId)
}

async function selection(): Promise<{ text: string; connected: boolean }> {
  return browser.execute(() => {
    const current = window.getSelection()!
    return { text: current.toString(), connected: current.anchorNode?.isConnected ?? false }
  })
}

const turn3Footer = `.concise-turn-footer[data-concise-turn-for="${TURN_3_PROMPT}"]`

describe('concise thread view toggling', () => {
  it('opens and closes one turn without moving the reader', async () => {
    await openScenario()
    // Put turn 3 near the top of the viewport.
    await browser.execute((id) => {
      document.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ block: 'start' })
    }, TURN_3_PROMPT)
    const promptBefore = await offsetFromListTop(`[data-message-id="${TURN_3_PROMPT}"]`)
    const scrollBefore = await browser.execute(
      () => document.querySelector('.messages-list')!.scrollTop,
    )
    expect(await visibleToolCards()).toBe(0)

    // Opening unfolds the steps beneath the prompt, which stays where it was.
    await $(`${turn3Footer} button`).click()
    await expect($(`${turn3Footer} button`)).toHaveAttribute('aria-expanded', 'true')
    expect(await visibleToolCards()).toBeGreaterThan(0)
    expect(await offsetFromListTop(`[data-message-id="${TURN_3_PROMPT}"]`)).toBe(promptBefore)
    expect(await browser.execute(() => document.querySelector('.messages-list')!.scrollTop)).toBe(
      scrollBefore,
    )
    await saveAppScreenshot('concise-thread-toggle-open.png')

    // Closing keeps the footer under the pointer rather than snapping the page.
    await browser.execute((sel) => {
      document.querySelector(sel)?.scrollIntoView({ block: 'center' })
    }, turn3Footer)
    const footerBefore = await offsetFromListTop(turn3Footer)
    await $(`${turn3Footer} button`).click()
    await expect($(`${turn3Footer} button`)).toHaveAttribute('aria-expanded', 'false')
    expect(await visibleToolCards()).toBe(0)
    expect(await offsetFromListTop(turn3Footer)).toBe(footerBefore)
    await saveAppScreenshot('concise-thread-toggle-closed.png')
  })

  it('keeps the reader’s text selection through a keyboard toggle', async () => {
    await openScenario()
    // Turn 2's reply sits above turn 3, out of the way of the selection popover.
    // (A pointer press anywhere in the transcript dismisses a selection by design —
    // selection-quote.ts — so the toggle is driven from the keyboard here.)
    await browser.execute((id) => {
      document.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ block: 'start' })
    }, TURN_3_PROMPT)
    const selected = await selectText(SELECTED_REPLY)
    expect(selected).toContain('switched it to a grid')
    const toggle = `${turn3Footer} button`
    await browser.execute((sel) => document.querySelector<HTMLElement>(sel)?.focus(), toggle)

    await browser.keys('Enter')
    await expect($(toggle)).toHaveAttribute('aria-expanded', 'true')
    expect(await selection()).toEqual({ text: selected, connected: true })

    await browser.keys('Enter')
    await expect($(toggle)).toHaveAttribute('aria-expanded', 'false')
    expect(await selection()).toEqual({ text: selected, connected: true })
    // The toggle kept keyboard focus through both rebuilds of the view.
    expect(await browser.execute((sel) => document.activeElement?.matches(sel), toggle)).toBe(true)
  })

  it('keeps each opened turn open independently', async () => {
    await openScenario()
    const footers = await $$('.concise-turn-footer')
    expect(footers).toHaveLength(3)
    await footers[0]?.$('button').click()
    await footers[2]?.$('button').click()
    await expect(footers[0]?.$('button')).toHaveAttribute('aria-expanded', 'true')
    await expect(footers[1]?.$('button')).toHaveAttribute('aria-expanded', 'false')
    await expect(footers[2]?.$('button')).toHaveAttribute('aria-expanded', 'true')
    await footers[0]?.$('button').click()
    await expect(footers[0]?.$('button')).toHaveAttribute('aria-expanded', 'false')
    await expect(footers[2]?.$('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('holds the reading position when Concise threads is turned off and on in Settings', async () => {
    await openScenario()
    await browser.execute((id) => {
      document.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ block: 'start' })
    }, TURN_3_PROMPT)
    const promptSel = `[data-message-id="${TURN_3_PROMPT}"]`
    const before = await offsetFromListTop(promptSel)

    const flip = async (): Promise<void> => {
      await $('[aria-label="Settings"]').click()
      await $('.settings-nav-btn[data-section="appearance"]').click()
      await $('input[name="conciseThreadsEnabled"]').waitForDisplayed()
      await $('input[name="conciseThreadsEnabled"]').scrollIntoView({ block: 'center' })
      await $('input[name="conciseThreadsEnabled"]').click()
      await $('.settings-buttons button[type="submit"]').click()
      await $('#settings-dialog').waitForDisplayed({ reverse: true })
      await browser.pause(200)
    }

    await flip()
    // Off: the full transcript, with every turn's steps in it, and no footers.
    expect(await visibleToolCards()).toBeGreaterThan(0)
    await expect($('.concise-turn-footer')).not.toBeExisting()
    expect(Math.abs((await offsetFromListTop(promptSel)) - before)).toBeLessThanOrEqual(2)
    await saveAppScreenshot('concise-thread-setting-off.png')

    await flip()
    expect(await visibleToolCards()).toBe(0)
    await expect($('.concise-turn-footer')).toBeExisting()
    expect(Math.abs((await offsetFromListTop(promptSel)) - before)).toBeLessThanOrEqual(2)
  })
})
