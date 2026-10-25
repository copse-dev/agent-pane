import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

/** The panel control toggles, so only click it when the Context pane is not already showing. */
async function openContext(): Promise<void> {
  if (!(await $('.thread-context').isDisplayed())) {
    if (!(await $('#pane-files').isDisplayed()))
      await $('[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open thread context"]').click()
  }
  await $('.thread-context').waitForDisplayed({ timeout: 20_000 })
}

describe("An external ACP agent's own background subagents (not Copse's native task tool)", () => {
  it('counts concurrent dispatches in the activity bar and lists them in the Context panel', async () => {
    await browser.url('/?scenario=acp-subagent-visibility&autoplay=0')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    // Two of the three dispatched agents are still running, both "Explore" —
    // the footer collapsed this to a single bare "Agent…" before this change.
    await expect($('.agent-activity-label')).toHaveText('Running 2 Explore agents…')

    await openContext()
    const rows = $$('[data-subagent-id]')
    await expect(rows).toBeElementsArrayOfSize(3)
    await expect($$('[data-subagent-id] .thread-context-title')).toHaveText([
      'explore',
      'explore',
      'investigate',
    ])
    await expect($$('[data-subagent-id] .thread-context-sub')).toHaveText([
      'Panel/view registration and local content serving',
      'Local file-tree reading utilities',
      'Servo sidecar and Rust toolchain precedent',
    ])
    await expect($('[data-context-section="subagents"] .thread-context-count')).toHaveText(
      '2 running · 1 done',
    )
    await saveAppScreenshot('acp-subagent-visibility.png')
  })
})
