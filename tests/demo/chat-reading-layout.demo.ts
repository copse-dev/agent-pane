import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot, saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const PROSE = '.messages-list > .msg-assistant > .message-body > .message-text'

async function readProseMetrics(selector: string) {
  return browser.execute((target) => {
    const prose = [...document.querySelectorAll<HTMLElement>(target)].at(-1)
    if (!prose) throw new Error('Missing assistant prose')
    const style = getComputedStyle(prose)
    const paragraphs = [...prose.querySelectorAll('p')]
    const first = paragraphs[0]?.getBoundingClientRect()
    const second = paragraphs[1]?.getBoundingClientRect()
    const code = prose.querySelector('pre')
    const nested = prose.querySelector('ul ul')
    return {
      width: prose.getBoundingClientRect().width,
      fontSize: parseFloat(style.fontSize),
      lineHeight: parseFloat(style.lineHeight),
      paragraphGap: first && second ? second.top - first.bottom : 0,
      overflow: prose.scrollWidth - prose.clientWidth,
      codeScrolls: code ? code.scrollWidth > code.clientWidth : false,
      nestedIndent: nested
        ? nested.getBoundingClientRect().left - prose.getBoundingClientRect().left
        : 0,
    }
  }, selector)
}

async function scrollToStart(): Promise<void> {
  await browser.execute(() => {
    const list = document.querySelector('.messages-list')
    if (list) list.scrollTop = 0
  })
}

describe('assistant Reading layout in the real renderer', () => {
  before(async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $(PROSE).waitForExist()
    await browser.execute(async () => {
      await document.fonts.ready
    })
    await scrollToStart()
  })

  it('uses a readable measure and paragraph rhythm without breaking rich markdown', async () => {
    const metrics = await readProseMetrics(PROSE)
    expect(metrics.width).toBeLessThanOrEqual(720)
    expect(metrics.width).toBeGreaterThan(500)
    expect(metrics.fontSize).toBe(16)
    expect(metrics.lineHeight).toBeCloseTo(26.4, 1)
    expect(metrics.paragraphGap).toBeGreaterThanOrEqual(15)
    expect(metrics.overflow).toBeLessThanOrEqual(1)
    expect(metrics.codeScrolls).toBe(true)
    expect(metrics.nestedIndent).toBeGreaterThan(20)
    expect(await $$(`${PROSE} table tbody tr`).length).toBe(3)
    await saveAppScreenshot('chat-reading-layout-dark.png')
    await $(`${PROSE} table`).scrollIntoView({ block: 'center', inline: 'nearest' })
    await saveElementScreenshot(`${PROSE} table`, 'chat-reading-layout-table.png')
    await scrollToStart()
  })

  it('wraps in a light narrow split while code keeps its own horizontal scroll', async () => {
    const files = $('#pane-files')
    if (!(await files.isDisplayed())) {
      await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
      await files.waitForDisplayed()
    }
    await browser.execute(() => {
      // Geometry fixtures at existing theme/layout boundaries; no product flags.
      document.documentElement.dataset.theme = 'light'
      document.getElementById('body')?.style.setProperty('--files-width', '600px')
    })
    await scrollToStart()
    const metrics = await readProseMetrics(PROSE)
    expect(metrics.width).toBeLessThan(460)
    expect(metrics.width).toBeGreaterThan(150)
    expect(metrics.fontSize).toBe(16)
    expect(metrics.overflow).toBeLessThanOrEqual(1)
    expect(metrics.codeScrolls).toBe(true)
    const overflow = await browser.execute(() => {
      const pane = document.getElementById('pane-chat')
      if (!pane) throw new Error('Missing chat pane')
      return pane.scrollWidth - pane.clientWidth
    })
    expect(overflow).toBeLessThanOrEqual(1)
    await saveAppScreenshot('chat-reading-layout-light-narrow.png')
    await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
    await browser.execute(() => {
      document.documentElement.dataset.theme = 'dark'
    })
  })

  it('scales prose and spacing with the existing interface scale', async () => {
    await browser.execute(() => {
      document.documentElement.style.setProperty('--ui-scale', '1.25')
    })
    const metrics = await readProseMetrics(PROSE)
    expect(metrics.fontSize).toBe(20)
    expect(metrics.lineHeight).toBeCloseTo(33, 1)
    expect(metrics.paragraphGap).toBeGreaterThanOrEqual(19)
    expect(metrics.overflow).toBeLessThanOrEqual(1)
    await scrollToStart()
    await saveAppScreenshot('chat-reading-layout-scaled.png')
    await browser.execute(() => {
      document.documentElement.style.removeProperty('--ui-scale')
    })
  })

  it('keeps the reading size through a real composer submission, tools, and stream completion', async () => {
    expect(await $$('.msg-user').length).toBe(1)
    expect(await $$(`${PROSE}.is-streaming`).length).toBe(0)
    await browser.execute(() => {
      const composer = document.querySelector<HTMLElement>('.prompt-input')
      if (!composer) throw new Error('Missing composer')
      composer.textContent = 'Show the reading layout with a streamed response.'
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await $('.submit-btn').click()
    await expect($$('.msg-user')).toBeElementsArrayOfSize(2)
    const liveProse = `${PROSE}.is-streaming`
    await $(liveProse).waitForExist()
    const live = await readProseMetrics(liveProse)
    expect(live.fontSize).toBe(16)
    expect(live.lineHeight).toBeCloseTo(26.4, 1)
    await $('.tool-card').waitForExist({ timeout: 15_000 })
    const mixed = await browser.execute(() => {
      const card = document.querySelector('.tool-card')
      const message = card?.closest('.msg-assistant')
      const prose = message?.querySelector('.message-body > .message-text')
      if (!card || !prose) throw new Error('Missing prose alongside the tool')
      return {
        proseSize: getComputedStyle(prose).fontSize,
        toolSize: getComputedStyle(card).fontSize,
      }
    })
    expect(mixed.proseSize).toBe('16px')
    expect(parseFloat(mixed.toolSize)).toBeLessThan(16)
    await saveAppScreenshot('chat-reading-layout-streaming.png')
    await browser.waitUntil(async () => (await $$(liveProse).length) === 0, {
      timeout: 30_000,
      timeoutMsg: 'Response should finish streaming',
    })
    const answers = await $$(PROSE)
    const final = answers[answers.length - 1]
    if (!final) throw new Error('Missing completed answer')
    await expect(final).toHaveText(expect.stringContaining('deterministic layout fixture'))
    expect((await readProseMetrics(`${PROSE}:not(.is-streaming)`)).fontSize).toBe(16)
    await saveAppScreenshot('chat-reading-layout-complete.png')
  })
})
