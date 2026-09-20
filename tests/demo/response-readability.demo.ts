import { $, $$, browser, expect } from '@wdio/globals'
import { mkdirSync, writeFileSync } from 'node:fs'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function capture(name: string): Promise<void> {
  await saveElementScreenshot('.workbench', name)
  // Optional text transport for image review in sandboxes without a local image viewer.
  if (process.env['COPSE_PROTOTYPE_REVIEW'] === '1') {
    mkdirSync('.tmp/response-readability', { recursive: true })
    const encoded = await $('.workbench').takeScreenshot()
    writeFileSync(
      `.tmp/response-readability/${name}.base64`,
      encoded.match(/.{1,2000}/g)?.join('\n') ?? '',
    )
  }
}

async function assertNoHorizontalOverflow(): Promise<void> {
  const overflow = await browser.execute(() =>
    ['.chat-panel', '.transcript', '#answer', '.workbench'].map((selector) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing ${selector}`)
      return { selector, overflow: element.scrollWidth - element.clientWidth }
    }),
  )
  for (const measurement of overflow) {
    expect(measurement.overflow).toBeLessThanOrEqual(1)
  }
}

describe('response readability design workshop', () => {
  before(async () => {
    await browser.url('/prototypes/response-readability/index.html')
    await $('#answer strong').waitForDisplayed()
    await browser.execute(async () => {
      await document.fonts.ready
    })
  })

  it('compares the same words with a narrower reading measure and looser leading', async () => {
    await $('[data-view="baseline"]').click()
    const before = await $('#answer').getText()
    const baseline = await browser.execute(() => {
      const column = document.querySelector('.reading-column')
      const answer = document.querySelector('#answer')
      if (!column || !answer) throw new Error('Missing answer')
      return {
        width: column.getBoundingClientRect().width,
        leading: parseFloat(getComputedStyle(answer).lineHeight),
      }
    })
    await capture('response-readability-baseline.png')
    await $('button[data-view="reading"]').click()
    expect(await $('#answer').getText()).toBe(before)
    const reading = await browser.execute(() => {
      const column = document.querySelector('.reading-column')
      const answer = document.querySelector('#answer')
      if (!column || !answer) throw new Error('Missing answer')
      return {
        width: column.getBoundingClientRect().width,
        leading: parseFloat(getComputedStyle(answer).lineHeight),
      }
    })
    expect(reading.width).toBeLessThanOrEqual(720)
    expect(reading.width).toBeLessThan(baseline.width)
    expect(reading.leading).toBeGreaterThan(baseline.leading)
    await assertNoHorizontalOverflow()
    await capture('response-readability-reading.png')
  })

  it('discloses activity without hiding answer limitations', async () => {
    await $('button[data-view="structured"]').click()
    await expect($('.result-heading')).toHaveText('One result per file.')
    await expect($('#answer')).toHaveText(expect.stringContaining('Full end-to-end suite not run.'))
    expect(await $$('.change-row').length).toBe(2)
    expect(await $('.activity').getAttribute('open')).toBeNull()
    await $('.activity summary').click()
    await expect($('#activity-list')).toBeDisplayed()
    await expect($('#activity-list')).toHaveText(expect.stringContaining('42 passed'))
    await $('.activity summary').click()
    await capture('response-readability-structured.png')
  })

  it('turns an explanation into a readable flow and reflows it in a narrow pane', async () => {
    await $('[data-example="explain"]').click()
    expect(await $$('.flow-step').length).toBe(3)
    await capture('response-readability-flow.png')
    await $('#width-select').selectByAttribute('value', 'narrow')
    const flow = await browser.execute(() => {
      const steps = [...document.querySelectorAll('.flow-step')].map((step) =>
        step.getBoundingClientRect(),
      )
      return { first: steps[0]?.top ?? 0, last: steps[2]?.top ?? 0 }
    })
    expect(flow.last).toBeGreaterThan(flow.first + 100)
    await assertNoHorizontalOverflow()
  })

  it('keeps review priorities, evidence, and limits readable in a light narrow pane', async () => {
    await $('[data-example="review"]').click()
    await $('#theme-toggle').click()
    await expect($('html')).toHaveAttribute('data-theme', 'light')
    await expect($('.severity')).toHaveText('High priority')
    await expect($('#answer')).toHaveText(expect.stringContaining('No tests run or files changed.'))
    const width = await $('.chat-panel').getSize('width')
    expect(width).toBeLessThanOrEqual(420)
    await assertNoHorizontalOverflow()
    await capture('response-readability-review-light.png')
  })

  it('supports a small viewport and direct links to a selected specimen', async () => {
    await browser.setWindowSize(560, 850)
    await browser.url('/prototypes/response-readability/index.html?example=explain#structured')
    await $('.flow').waitForDisplayed()
    await expect($('button[data-view="structured"]')).toHaveAttribute('aria-pressed', 'true')
    await expect($('[data-example="explain"]')).toHaveAttribute('aria-pressed', 'true')
    await assertNoHorizontalOverflow()
  })
})
