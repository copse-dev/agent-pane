// Contract test for the renderer's text-selection policy.
//
// The app is a desktop-chrome UI: base.css sets `user-select: none` on <body> so
// drag-selecting never sweeps up tabs, labels, or prompts, then re-enables
// selection on the regions that hold *content* — text the user authors (inputs)
// and agent/tool output the user may want to copy (rendered markdown answers,
// reasoning, tool results, and the terminal). Chrome like the permission prompt
// stays non-selectable. happy-dom has no selection engine, so we pin the policy
// at the stylesheet level instead of exercising it in the DOM.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_CSS = resolve(process.cwd(), 'src/renderer/styles/global/base.css')

/** The comma-separated selector list of the rule that turns selection back on. */
function selectableSelectors(): string[] {
  const css = readFileSync(BASE_CSS, 'utf8')
  // Find the flat rule whose body declares `user-select: text`, and capture the
  // selector prelude (everything after the previous `}` up to this rule's `{`).
  const match = css.match(/(?:^|})\s*([^{}]+?)\s*\{[^}]*user-select:\s*text[^}]*\}/)
  assert.ok(match?.[1], 'base.css must define a rule that sets user-select: text')
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

describe('text-selection policy', () => {
  it('denies selection on desktop chrome by default', () => {
    const css = readFileSync(BASE_CSS, 'utf8')
    const body = css.slice(css.search(/\bbody\s*\{/), css.indexOf('}', css.search(/\bbody\s*\{/)))
    assert.match(
      body,
      /user-select:\s*none/,
      '<body> must default to user-select: none so chrome is not selectable',
    )
  })

  it('makes agent/tool content selectable so it can be copied', () => {
    const selectors = selectableSelectors()
    for (const selector of [
      '.message-text', // rendered markdown answers
      '.message-reasoning-text', // rendered "Thinking" markdown
      '.tool-result', // tool output
      '.tool-args pre', // tool arguments
      '.terminal-container', // terminal output
      '.monaco-editor .view-lines', // editor content
    ]) {
      assert.ok(
        selectors.includes(selector),
        `${selector} holds copyable content and must be user-select: text`,
      )
    }
  })

  it('keeps the permission prompt non-selectable (it is chrome, not content)', () => {
    assert.ok(
      !selectableSelectors().includes('.approval-body'),
      '.approval-body is a permission prompt message and must stay non-selectable',
    )
  })
})
