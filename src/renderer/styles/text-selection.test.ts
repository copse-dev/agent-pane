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
const TOKENS_CSS = resolve(process.cwd(), 'src/renderer/styles/tokens.css')
const THEMES_CSS = resolve(process.cwd(), 'src/renderer/styles/themes.css')
const TERMINALS = resolve(process.cwd(), 'src/renderer/views/terminals-pane.ts')

/** Relative luminance of a `#rrggbb` colour, per WCAG 2.1. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** WCAG contrast ratio between two `#rrggbb` colours (1:1 … 21:1). */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

/**
 * Last declared value of `--name` inside the block opened by `selector`. Both
 * token files declare one flat block per theme, so a scan from the selector to
 * its closing brace is enough.
 */
function token(css: string, selector: string, name: string): string {
  const start = css.indexOf(selector)
  assert.notEqual(start, -1, `${selector} must exist`)
  const block = css.slice(start, css.indexOf('\n}', start))
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  assert.ok(match?.[1], `${selector} must declare ${name} as a literal hex colour`)
  return match[1].toLowerCase()
}

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
      '.message-reasoning-text', // rendered Reasoning markdown
      '.tool-result', // tool output
      '.tool-args pre', // tool arguments
      '.attachment-preview-text', // sent text attachment snapshots
      '.terminal-container', // interactive terminal output
      '.agent-task-output-panel', // agent-run terminal output
      '.monaco-editor .view-lines', // editor content
    ]) {
      assert.ok(
        selectors.includes(selector),
        `${selector} holds copyable content and must be user-select: text`,
      )
    }
  })

  it('declares its own ::selection so the unfocused highlight stays readable', () => {
    const css = readFileSync(BASE_CSS, 'utf8')
    const start = css.indexOf('::selection')
    assert.notEqual(
      start,
      -1,
      'base.css must declare ::selection — the UA fallback for an unfocused window is a flat grey',
    )
    const body = css.slice(start, css.indexOf('}', start))
    assert.match(body, /background:\s*var\(--selection-bg\)/)
    assert.match(
      body,
      /color:\s*var\(--selection-text\)/,
      'the highlight must set a foreground too, or selected text keeps its own (invisible) colour',
    )
  })

  it('keeps selection and search-match text legible in both themes', () => {
    const tokens = readFileSync(TOKENS_CSS, 'utf8')
    const themes = readFileSync(THEMES_CSS, 'utf8')
    // Dark lives in tokens.css (:root); light restates the pairs in themes.css.
    const themed: Array<[string, string]> = [
      ['dark', tokens],
      ['light', themes],
    ]
    for (const [theme, css] of themed) {
      const selector = theme === 'dark' ? ':root' : "[data-theme='light']"
      for (const fill of ['--selection', '--highlight-current']) {
        const background = token(css, selector, `${fill}-bg`)
        const foreground = token(css, selector, `${fill}-text`)
        const ratio = contrast(background, foreground)
        assert.ok(
          ratio >= 4.5,
          `${theme} ${fill} (${foreground} on ${background}) is ${ratio.toFixed(2)}:1 — WCAG AA needs 4.5:1`,
        )
      }
    }
  })

  it('gives the terminal an inactive selection colour per theme', () => {
    const source = readFileSync(TERMINALS, 'utf8')
    // xterm's default (#3A3D41) is a dark grey: fine on the dark surface, a
    // near-black block under near-black text on the light one.
    const inactive = [...source.matchAll(/selectionInactiveBackground:\s*'(#[0-9a-fA-F]{6})'/g)]
    assert.equal(inactive.length, 2, 'both xterm themes must set selectionInactiveBackground')
    const foregrounds = [...source.matchAll(/foreground:\s*'(#[0-9a-fA-F]{6})'/g)]
    for (const [index, match] of inactive.entries()) {
      const background = match[1] ?? ''
      const text = foregrounds[index]?.[1] ?? ''
      assert.ok(
        contrast(background, text) >= 4.5,
        `terminal text ${text} is unreadable on the inactive selection ${background}`,
      )
    }
  })

  it('keeps the permission prompt non-selectable (it is chrome, not content)', () => {
    for (const selector of ['.approval-body', '.approval-advice', '.approval-footer']) {
      assert.ok(
        !selectableSelectors().includes(selector),
        `${selector} is a permission prompt message and must stay non-selectable`,
      )
    }
  })
})
