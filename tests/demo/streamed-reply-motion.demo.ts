import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { analyzeStreamMotion, type StreamFrame } from './helpers/stream-motion.ts'

/**
 * A replayed turn arrives the way a provider's does — a dozen characters every
 * 50ms — so this measures what a reader sees of it, frame by frame: text that
 * appears every frame rather than in bursts, blocks that stay put when the
 * block below them finishes, a transcript that glides after the text instead
 * of lurching, and a final render that lands on exactly the streamed layout.
 */

/**
 * Record every animation frame of the newest reply until it has `stopAt`
 * characters, or — with `null` — until the run ends and the reply has settled.
 */
async function recordFrames(stopAt: number | null): Promise<StreamFrame[]> {
  return browser.execute(async (stopAtLength: number | null) => {
    const frames: StreamFrame[] = []
    const started = performance.now()
    let settledFrames = 0
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const texts = document.querySelectorAll<HTMLElement>(
          '.msg-assistant > .message-body > .message-text',
        )
        const text = texts[texts.length - 1]
        const row = text?.closest<HTMLElement>('.msg')
        const list = document.querySelector('.messages-list')
        if (text && row && list) {
          const host = text.querySelector(':scope > .stream-complete') ?? text
          const rowTop = row.getBoundingClientRect().top
          const blockTops = [...host.children]
            .filter((block) => block instanceof HTMLElement && !block.hidden)
            .map((block) => {
              // The first line box, so what counts is margins, not wrapping.
              const range = document.createRange()
              range.selectNodeContents(block)
              const first = range.getClientRects()[0] ?? block.getBoundingClientRect()
              return first.top - rowTop
            })
          frames.push({
            messageId: row.dataset['messageId'] ?? '',
            streaming: text.classList.contains('is-streaming'),
            length: text.textContent.length,
            height: text.getBoundingClientRect().height,
            scrollTop: list.scrollTop,
            blockTops,
          })
        }
        const last = frames[frames.length - 1]
        const running = document.querySelector('.submit-btn.with-stop') !== null
        if (stopAtLength === null && !running && last?.streaming === false) settledFrames++
        const done =
          stopAtLength === null
            ? settledFrames > 20
            : last?.streaming === true && last.length >= stopAtLength
        if (done || performance.now() - started > 25_000) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return frames
  }, stopAt)
}

describe('streamed reply motion in the real renderer', () => {
  it('reveals a paced reply smoothly and settles without a jump', async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $('.prompt-input').waitForExist()
    await browser.execute(async () => {
      await document.fonts.ready
      const composer = document.querySelector<HTMLElement>('.prompt-input')
      if (!composer) throw new Error('Missing composer')
      composer.textContent = 'Show the reading layout with a streamed response.'
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await $('.submit-btn').click()

    // The tool step and the first prose, then a capture mid-reply.
    const opening = await recordFrames(700)
    await saveAppScreenshot('streamed-reply-mid-stream.png')
    const closing = await recordFrames(null)
    await expect($$('.msg-assistant .message-text.is-streaming')).toBeElementsArrayOfSize(0)
    await saveAppScreenshot('streamed-reply-settled.png')

    const motion = analyzeStreamMotion([opening, closing])
    expect(motion.liveFrames).toBeGreaterThan(60)
    // Chunk-paced painting froze the text for two frames in three.
    expect(motion.advancingShare).toBeGreaterThan(0.8)
    expect(motion.p90CharsPerFrame).toBeLessThanOrEqual(12)
    // A finished block never nudges the ones above it.
    expect(motion.maxBlockShiftPx).toBeLessThanOrEqual(1)
    // Following the text glides instead of snapping a line or a block at once.
    expect(motion.maxScrollStepPx).toBeLessThanOrEqual(24)
    // The final render lands on the streamed layout.
    expect(motion.finalSwapHeightDeltaPx).not.toBeNull()
    expect(Math.abs(motion.finalSwapHeightDeltaPx ?? Infinity)).toBeLessThanOrEqual(1)
  })
})
