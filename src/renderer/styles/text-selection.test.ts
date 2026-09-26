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
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FALLBACK_EDITOR_THEME_TOKENS,
  xtermThemeFromTokens,
  type EditorThemeTokens,
} from '../dom/editor-theme.ts'

const GLOBAL_CSS_DIR = resolve(process.cwd(), 'src/renderer/styles/global')
const BASE_CSS = resolve(process.cwd(), 'src/renderer/styles/global/base.css')
const TOKENS_CSS = resolve(process.cwd(), 'src/renderer/styles/tokens.css')
const THEMES_CSS = resolve(process.cwd(), 'src/renderer/styles/themes.css')

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

  it('routes every ::selection rule through the selection tokens', () => {
    // A component that re-declares ::selection with its own colours opts out of
    // the guarantee the tokens carry. The address bar used to do exactly that
    // with var(--accent)/var(--text-on-accent), which reads at 1.24:1 in light.
    for (const file of readdirSync(GLOBAL_CSS_DIR).filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(resolve(GLOBAL_CSS_DIR, file), 'utf8')
      for (const rule of css.matchAll(/([^{}]*::selection)\s*\{([^}]*)\}/g)) {
        const [, selector = '', body = ''] = rule
        assert.match(
          body,
          /background:\s*var\(--selection-bg\)/,
          `${file}: ${selector.trim()} must take its fill from --selection-bg`,
        )
        assert.match(
          body,
          /color:\s*var\(--selection-text\)/,
          `${file}: ${selector.trim()} must take its foreground from --selection-text`,
        )
      }
    }
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

  it('keeps terminal selections legible, focused and not, in both themes', () => {
    // The xterm theme is derived from the tokens (dom/editor-theme.ts). xterm's
    // own inactive default (#3A3D41) is a dark grey: fine on the dark surface, a
    // near-black block under near-black text on the light one. Check the pair on
    // the untinted surfaces and on Strong + the Copse tint, the darkest one.
    const tokens = readFileSync(TOKENS_CSS, 'utf8')
    const themes = readFileSync(THEMES_CSS, 'utf8')
    const copseStrong =
      "[data-theme='dark'][data-tint-palette='copse'][data-tint-strength='strong']"
    const surfaces: Array<[string, EditorThemeTokens]> = [
      [
        'dark',
        {
          ...FALLBACK_EDITOR_THEME_TOKENS.dark,
          selectionBackground: token(tokens, ':root', '--selection-bg'),
          selectionForeground: token(tokens, ':root', '--selection-text'),
        },
      ],
      [
        'dark copse strong',
        {
          ...FALLBACK_EDITOR_THEME_TOKENS.dark,
          background: token(themes, copseStrong, '--bg-base'),
          selectionBackground: token(tokens, ':root', '--selection-bg'),
          selectionForeground: token(tokens, ':root', '--selection-text'),
        },
      ],
      [
        'light',
        {
          ...FALLBACK_EDITOR_THEME_TOKENS.light,
          selectionBackground: token(themes, "[data-theme='light']", '--selection-bg'),
          selectionForeground: token(themes, "[data-theme='light']", '--selection-text'),
        },
      ],
    ]
    for (const [surface, surfaceTokens] of surfaces) {
      const theme = xtermThemeFromTokens(surfaceTokens)
      const text = theme.selectionForeground ?? ''
      assert.ok(text, `${surface}: the terminal selection must set a foreground`)
      for (const background of [theme.selectionBackground, theme.selectionInactiveBackground]) {
        assert.ok(background, `${surface}: the terminal selection must set both fills`)
        assert.ok(
          contrast(background, text) >= 4.5,
          `${surface}: terminal text ${text} is unreadable on the selection ${background}`,
        )
      }
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
