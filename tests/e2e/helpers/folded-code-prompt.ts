import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'
import { parkPointer } from './screenshot.ts'

function foldedPromptCaptureState(selector: string): {
  menuOpen: boolean
  focused: boolean
  hovered: boolean
} {
  const row = document.querySelector(selector)
  const actions = row?.querySelector('.msg-actions')
  if (!row || !actions) throw new Error('Folded prompt capture requires its action strip')
  return {
    menuOpen: actions.classList.contains('is-open'),
    focused: actions.matches(':focus-within'),
    hovered: row.matches(':hover'),
  }
}

/**
 * Capture the resting state — actions menu closed, no hover or focus; element
 * screenshots can drop Chromium hover.
 */
export async function settleFoldedPromptCapture(selector: string): Promise<void> {
  await parkPointer()
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(foldedPromptCaptureState, selector)
      return !state.menuOpen && !state.focused && !state.hovered
    },
    { timeout: 2_000, timeoutMsg: 'Folded prompt action strip did not settle after hover' },
  )
  await assertFoldedPromptCaptureSettled(selector)
}

/** An immediate post-capture check catches a framing-induced hover/focus change. */
export async function assertFoldedPromptCaptureSettled(selector: string): Promise<void> {
  assert.deepEqual(await browser.execute(foldedPromptCaptureState, selector), {
    menuOpen: false,
    focused: false,
    hovered: false,
  })
}

export const FOLDED_CODE_PAYLOAD = [
  '{',
  '  "service": "release-notifier",',
  '  "intervalSeconds": 15,',
  '  "timeoutSeconds": 30,',
  '  "retryLimit": 3,',
  '  "region": "eu-west",',
  '  "notifications": {',
  '    "email": true,',
  '    "desktop": true,',
  '    "sound": false',
  '  },',
  '  "logging": "info"',
  '}',
].join('\n')

export const FOLDED_CODE_PROMPT = `Review this configuration before I change the timeout:\n\n\`\`\`json\n${FOLDED_CODE_PAYLOAD}\n\`\`\``
