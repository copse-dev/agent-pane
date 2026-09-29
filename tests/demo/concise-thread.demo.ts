import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// The same seeded turn — narration, reads, an edit, a failed-then-passing test
// run, a screenshot and a summary — rendered for a model above the concise gate
// and for one below it, plus the capable model mid-run. Asserts what each view
// paints and leaves each as a reviewable capture.

interface TranscriptState {
  toolCards: number
  reasoning: number
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
    await saveAppScreenshot('concise-thread.png')
  })

  it('keeps the full transcript for a model below the gate', async () => {
    await browser.url('/?scenario=concise-thread-full')
    await $('.msg-assistant .tool-card').waitForExist()
    await expect($('.msg-concise')).not.toBeExisting()

    const state = await transcriptState()
    expect(state.toolCards).toBeGreaterThan(0)
    expect(state.reasoning).toBe(1)
    expect(state.screenshots).toBe(1)
    expect(state.texts.length).toBeGreaterThan(1)
    await saveAppScreenshot('concise-thread-full.png')
    // The steps the concise view hides sit above the fold; capture them too.
    await browser.execute(() => {
      document.querySelector('.messages-list')?.scrollTo({ top: 0 })
    })
    await saveAppScreenshot('concise-thread-full-top.png')
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
