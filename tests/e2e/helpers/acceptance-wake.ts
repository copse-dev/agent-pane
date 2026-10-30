import { browser } from '@wdio/globals'
import type { MockTurn } from '../../../packages/llm/src/mock-script.ts'
import { diffAcceptancePrompt } from '../../../src/main/services/diff-acceptance-wake.ts'

/**
 * Accepting a proposal in the Changes panel wakes the proposing turn with a
 * hidden prompt (decision 5 in docs/plans/hooks-and-feature-packs.md). A spec
 * that accepts one must script that turn, or the mock provider answers the wake
 * with an "unexpected request" caution in the transcript.
 */
export function acceptanceWakeTurn(paths: string[], reply: string): MockTurn {
  return { user: { includes: diffAcceptancePrompt({ paths }) }, responses: [{ text: reply }] }
}

/** Visible chat prompts, and any caution callout (how a failed turn reports itself). */
export async function readTranscriptNotices(): Promise<{ prompts: string[]; cautions: string[] }> {
  return browser.execute(() => ({
    prompts: [...document.querySelectorAll('.msg-user .message-text')].map((el) =>
      el.textContent.trim(),
    ),
    cautions: [...document.querySelectorAll('blockquote.markdown-alert-caution')].map((el) =>
      el.textContent.trim(),
    ),
  }))
}
