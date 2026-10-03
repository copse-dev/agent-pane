import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// The same seeded turn — narration, reads, an edit, a failed-then-passing test
// run, a screenshot and a summary — rendered for a model above the concise gate
// and for one below it, plus the capable model mid-run and with the
// experimental setting off. Asserts what each view paints and leaves each as a
// reviewable capture.

interface TranscriptState {
  toolCards: number
  reasoning: number
  /** Trails the concise view keeps, whether open or folded in a closed rollup. */
  reasoningTrails: number
  screenshots: number
  texts: string[]
}

async function transcriptState(): Promise<TranscriptState> {
  return browser.execute(() => {
    const visible = (node: Element): boolean =>
      node instanceof HTMLElement && node.checkVisibility()
    const count = (selector: string): number =>
      [...document.querySelectorAll(`.messages-list ${selector}`)].filter(visible).length
    return {
      toolCards: count('.msg > .tool-card'),
      reasoning: count('.message-reasoning'),
      reasoningTrails: document.querySelectorAll(
        '.messages-list .msg:not(.msg-concise):not(.msg-concise-working) .message-reasoning',
      ).length,
      screenshots: count('.tool-result-preview-image'),
      texts: [...document.querySelectorAll('.messages-list .msg-assistant .message-text')]
        .filter(visible)
        .map((node) => node.textContent.trim()),
    }
  })
}

describe('concise thread view', () => {
  it('shows only the screenshot and summary for a model above the gate', async () => {
    await browser.url('/?scenario=concise-thread')
    await $('.msg-concise').waitForExist()
    await $('.tool-result-preview-image').waitForDisplayed()

    const state = await transcriptState()
    expect(state.toolCards).toBe(0)
    expect(state.reasoning).toBe(0)
    expect(state.screenshots).toBe(1)
    expect(state.texts).toHaveLength(1)
    expect(state.texts[0]).toContain('Save now stays pinned')
    // A process-only bubble with no output must take no room: it once survived
    // as an empty 16px band that stretched the gap under the prompt.
    const emptyBubbles = await browser.execute(
      () =>
        [...document.querySelectorAll('.messages-list > .msg-assistant')].filter(
          (node) => node instanceof HTMLElement && node.checkVisibility() && node.offsetHeight < 30,
        ).length,
    )
    expect(emptyBubbles).toBe(0)
    await saveAppScreenshot('concise-thread.png')
  })

  it('keeps prompts, replies and screenshots tightly spaced across several turns', async () => {
    await browser.url('/?scenario=concise-thread-multi')
    await $('.msg-concise').waitForExist()
    await $('.tool-result-preview-image').waitForDisplayed()

    const layout = await browser.execute(() => {
      const visible = (node: Element): node is HTMLElement =>
        node instanceof HTMLElement && node.checkVisibility()
      const bubbles = [...document.querySelectorAll('.messages-list > .msg')].filter(visible)
      return {
        // Process-only bubbles must take no room.
        emptyBubbles: bubbles.filter(
          (n) => n.classList.contains('msg-assistant') && n.offsetHeight < 30,
        ).length,
        // Space between each prompt's bottom edge and the first thing painted under it.
        promptGaps: bubbles.flatMap((node, i) => {
          const next = bubbles[i + 1]
          return node.classList.contains('msg-user') && next
            ? [Math.round(next.getBoundingClientRect().top - node.getBoundingClientRect().bottom)]
            : []
        }),
        rules: [...document.querySelectorAll('.messages-list .msg')].filter(
          (n) =>
            visible(n) &&
            ['Top', 'Bottom'].some(
              (side) =>
                getComputedStyle(n).getPropertyValue(`border-${side.toLowerCase()}-style`) !==
                'none',
            ),
        ).length,
      }
    })
    expect(layout.emptyBubbles).toBe(0)
    expect(layout.rules).toBe(0)
    expect(layout.promptGaps).toHaveLength(5)
    // The list gap (8px) plus the reply's own padding, never an extra empty band.
    for (const gap of layout.promptGaps) expect(gap).toBeLessThanOrEqual(24)

    for (const [index, top] of [0, 420, 1_000_000].entries()) {
      await browser.execute((scrollTop) => {
        document.querySelector('.messages-list')?.scrollTo({ top: scrollTop })
      }, top)
      await saveAppScreenshot(`concise-thread-multi-${index}.png`)
    }
  })

  it('opens only the running turn in the full view when its activity row is clicked', async () => {
    await browser.url('/?scenario=concise-thread-multi-working')
    await $('.msg-concise-working').waitForExist()
    const row = $('.agent-activity')
    await row.waitForDisplayed()
    await expect(row).toHaveAttribute('aria-expanded', 'false')

    const cards = () =>
      browser.execute(() => {
        const visible = (node: Element): boolean =>
          node instanceof HTMLElement && node.checkVisibility()
        const turns: { cards: number; reasoning: number }[] = []
        for (const node of document.querySelectorAll('.messages-list > .msg')) {
          if (node.classList.contains('msg-user')) turns.push({ cards: 0, reasoning: 0 })
          const turn = turns.at(-1)
          if (!turn) continue
          turn.cards += [...node.querySelectorAll(':scope > .tool-card, :scope .tool-card')].filter(
            visible,
          ).length
          turn.reasoning += [...node.querySelectorAll('.message-reasoning')].filter(visible).length
        }
        return turns
      })

    const before = await cards()
    expect(before.every((turn) => turn.cards === 0 && turn.reasoning === 0)).toBe(true)
    // Capture the live end of the thread, where the running row sits.
    await browser.execute(() => {
      document.querySelector('.messages-list')?.scrollTo({ top: 1_000_000 })
    })
    await saveAppScreenshot('concise-thread-running-collapsed.png')

    await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    const open = await cards()
    // The live turn is last; it shows its steps again while earlier turns stay concise.
    expect(open.at(-1)?.cards).toBeGreaterThan(0)
    expect(open.slice(0, -1).every((turn) => turn.cards === 0 && turn.reasoning === 0)).toBe(true)
    await saveAppScreenshot('concise-thread-running-expanded.png')

    await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'false')
    expect((await cards()).every((turn) => turn.cards === 0 && turn.reasoning === 0)).toBe(true)
  })

  it('keeps the full transcript for a model below the gate', async () => {
    await browser.url('/?scenario=concise-thread-full')
    await $('.msg-assistant .tool-card').waitForExist()
    await expect($('.msg-concise')).not.toBeExisting()

    const state = await transcriptState()
    expect(state.toolCards).toBeGreaterThan(0)
    // Finished activity starts collapsed, so the trail can sit folded inside
    // the closed rollup: kept in the transcript, not hidden by the concise view.
    expect(state.reasoningTrails).toBe(1)
    expect(state.screenshots).toBe(1)
    expect(state.texts.length).toBeGreaterThan(1)
    await saveAppScreenshot('concise-thread-full.png')
    // The steps the concise view hides sit above the fold; capture them too.
    await browser.execute(() => {
      document.querySelector('.messages-list')?.scrollTo({ top: 0 })
    })
    await saveAppScreenshot('concise-thread-full-top.png')
  })

  it('keeps the full transcript for a capable model while the experiment is off', async () => {
    await browser.url('/?scenario=concise-thread-disabled')
    await $('.msg-assistant .tool-card').waitForExist()
    await expect($('.msg-concise')).not.toBeExisting()

    const state = await transcriptState()
    expect(state.toolCards).toBeGreaterThan(0)
    // Finished activity starts collapsed, so the trail can sit folded inside
    // the closed rollup: kept in the transcript, not hidden by the concise view.
    expect(state.reasoningTrails).toBe(1)
    expect(state.texts.length).toBeGreaterThan(1)
  })

  it('shows just the spinner and the current item while the model works', async () => {
    await browser.url('/?scenario=concise-thread-working')
    await $('.msg-concise-working').waitForExist()
    const activity = $('.agent-activity')
    await activity.waitForDisplayed()
    await expect($('.agent-activity-label')).toHaveText('Running pnpm test -- settings-forms…')

    const state = await transcriptState()
    expect(state.toolCards).toBe(0)
    expect(state.reasoning).toBe(0)
    expect(state.texts).toEqual([])
    await saveAppScreenshot('concise-thread-working.png')
  })
})
