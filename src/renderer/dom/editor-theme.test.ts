import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Theme } from '@shared/types/state.ts'
import {
  COPSE_MONACO_THEME,
  EDITOR_THEME_TOKEN_FIELDS,
  EDITOR_THEME_TOKEN_PROPERTIES,
  FALLBACK_EDITOR_THEME_TOKENS,
  cssColorToHex,
  installMonacoEditorTheme,
  mixHex,
  monacoThemeFromTokens,
  readEditorThemeTokens,
  watchEditorTheme,
  xtermThemeFromTokens,
  type EditorThemeTokens,
} from './editor-theme.ts'

const COPSE_STRONG: EditorThemeTokens = {
  scheme: 'dark',
  background: '#002e2b',
  elevated: '#073936',
  foreground: '#f9fcff',
  border: '#28534f',
  borderSubtle: '#16413d',
  selectionBackground: '#2f6fd0',
  selectionForeground: '#ffffff',
}

/** Resolve a flush microtask so MutationObserver callbacks have run. */
async function flushObservers(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0))
}

afterEach(() => {
  const root = document.documentElement
  delete root.dataset['theme']
  root.removeAttribute('style')
})

describe('cssColorToHex', () => {
  it('accepts every opaque form Chromium serialises a resolved token as', () => {
    assert.equal(cssColorToHex('#002E2B'), '#002e2b')
    assert.equal(cssColorToHex('#abc'), '#aabbcc')
    assert.equal(cssColorToHex('#112233ff'), '#112233')
    assert.equal(cssColorToHex('rgb(0, 46, 43)'), '#002e2b')
    assert.equal(cssColorToHex('rgba(0, 46, 43, 1)'), '#002e2b')
    assert.equal(cssColorToHex('rgb(0 46 43 / 100%)'), '#002e2b')
    assert.equal(cssColorToHex('color(srgb 0.118588 0.124863 0.118745)'), '#1e201e')
    assert.equal(cssColorToHex('color(srgb 0 0.180392 0.168627 / 1)'), '#002e2b')
  })

  it('rejects translucent, non-sRGB and unparseable colours', () => {
    assert.equal(cssColorToHex('rgba(0, 0, 0, 0)'), null)
    assert.equal(cssColorToHex('rgb(0 46 43 / 0.5)'), null)
    assert.equal(cssColorToHex('#11223380'), null)
    assert.equal(cssColorToHex('color(display-p3 0 0.2 0.2)'), null)
    assert.equal(cssColorToHex('color-mix(in srgb, #244c25 4%, #1e1e1e)'), null)
    assert.equal(cssColorToHex(''), null)
  })
})

describe('mixHex', () => {
  it('matches color-mix(in srgb, a weight, b)', () => {
    assert.equal(mixHex('#ffffff', '#000000', 0.5), '#808080')
    assert.equal(mixHex('#2f6fd0', '#1e1e1e', 1), '#2f6fd0')
    assert.equal(mixHex('#2f6fd0', '#1e1e1e', 0), '#1e1e1e')
  })
})

describe('xtermThemeFromTokens', () => {
  it('paints the terminal from the pane surface and text tokens', () => {
    const theme = xtermThemeFromTokens(COPSE_STRONG)
    assert.equal(theme.background, '#002e2b')
    assert.equal(theme.foreground, '#f9fcff')
    assert.equal(theme.cursor, '#f9fcff')
    assert.equal(theme.cursorAccent, '#002e2b')
  })

  it('declares both halves of the selection, focused and not', () => {
    const theme = xtermThemeFromTokens(COPSE_STRONG)
    assert.equal(theme.selectionBackground, '#2f6fd0')
    assert.equal(theme.selectionForeground, '#ffffff')
    // One step quieter than the focused fill, washed toward the surface.
    assert.equal(theme.selectionInactiveBackground, mixHex('#2f6fd0', '#002e2b', 0.6))
  })
})

describe('monacoThemeFromTokens', () => {
  it('layers the surfaces over the matching stock theme', () => {
    const dark = monacoThemeFromTokens(COPSE_STRONG)
    assert.equal(dark.base, 'vs-dark')
    assert.equal(dark.inherit, true)
    assert.deepEqual(dark.rules, [])
    assert.deepEqual(dark.colors, {
      'editor.background': '#002e2b',
      'editor.foreground': '#f9fcff',
      'editor.lineHighlightBorder': '#16413d',
      'editorWidget.background': '#073936',
      'editorWidget.border': '#28534f',
      'diffEditor.unchangedRegionBackground': '#073936',
    })
    assert.equal(monacoThemeFromTokens(FALLBACK_EDITOR_THEME_TOKENS.light).base, 'vs')
  })

  it('leaves syntax and selection colours to the base theme', () => {
    const { colors, rules } = monacoThemeFromTokens(COPSE_STRONG)
    assert.equal(rules.length, 0)
    assert.equal(Object.hasOwn(colors, 'editor.selectionBackground'), false)
  })
})

describe('FALLBACK_EDITOR_THEME_TOKENS', () => {
  // The fallback is the untinted palette; keep it in step with the stylesheets so a
  // token that fails to resolve degrades to the theme's own colour, not a stale one.
  const tokensCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/tokens.css'), 'utf8')
  const themesCss = readFileSync(resolve(process.cwd(), 'src/renderer/styles/themes.css'), 'utf8')

  function literal(css: string, selector: string, name: string): string | undefined {
    const start = css.indexOf(selector)
    const block = css.slice(start, css.indexOf('\n}', start))
    const direct = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1]
    // Surfaces are `color-mix(in srgb, var(--tint-hue) …, <base grey>)`.
    const mixed = new RegExp(`${name}:\\s*color-mix\\([^;]*,\\s*(#[0-9a-fA-F]{6})\\)`).exec(
      block,
    )?.[1]
    return (direct ?? mixed)?.toLowerCase()
  }

  const sheets: Array<[Theme, string, string]> = [
    ['dark', tokensCss, ':root {'],
    ['light', themesCss, "[data-theme='light'] {"],
  ]
  for (const [scheme, css, selector] of sheets) {
    it(`matches the ${scheme} stylesheet`, () => {
      const fallback = FALLBACK_EDITOR_THEME_TOKENS[scheme]
      for (const field of EDITOR_THEME_TOKEN_FIELDS) {
        const property = EDITOR_THEME_TOKEN_PROPERTIES[field]
        const expected = literal(css, selector, property)
        assert.ok(expected, `${selector} must declare ${property}`)
        assert.equal(fallback[field], expected, `${scheme} ${property}`)
      }
    })
  }
})

describe('readEditorThemeTokens', () => {
  it('follows data-theme and falls back per token when nothing resolves', () => {
    // happy-dom has no cascade, so every token takes the fallback.
    assert.deepEqual(readEditorThemeTokens(), FALLBACK_EDITOR_THEME_TOKENS.dark)
    document.documentElement.dataset['theme'] = 'light'
    assert.deepEqual(readEditorThemeTokens(), FALLBACK_EDITOR_THEME_TOKENS.light)
    assert.equal(document.documentElement.querySelector('span'), null, 'probe is removed')
  })
})

describe('watchEditorTheme', () => {
  it('re-resolves when the appearance on <html> changes, and only then', async () => {
    const seen: EditorThemeTokens[] = []
    const stop = watchEditorTheme((tokens) => {
      seen.push(tokens)
    })
    document.documentElement.style.setProperty('--ui-scale', '1.25')
    await flushObservers()
    assert.equal(seen.length, 0, 'an unrelated root write resolves to the same tokens')

    document.documentElement.dataset['theme'] = 'light'
    await flushObservers()
    assert.deepEqual(seen, [FALLBACK_EDITOR_THEME_TOKENS.light])

    stop()
    document.documentElement.dataset['theme'] = 'dark'
    await flushObservers()
    assert.equal(seen.length, 1, 'no callbacks after disposal')
  })
})

describe('installMonacoEditorTheme', () => {
  it('defines and selects the Copse theme, then keeps it current', async () => {
    const calls: string[] = []
    const stop = installMonacoEditorTheme({
      editor: {
        defineTheme: (name, data) => {
          calls.push(`define ${name} ${data.base}`)
        },
        setTheme: (name) => {
          calls.push(`set ${name}`)
        },
      },
    })
    assert.deepEqual(calls, [`define ${COPSE_MONACO_THEME} vs-dark`, `set ${COPSE_MONACO_THEME}`])

    document.documentElement.dataset['theme'] = 'light'
    await flushObservers()
    assert.deepEqual(calls.slice(2), [
      `define ${COPSE_MONACO_THEME} vs`,
      `set ${COPSE_MONACO_THEME}`,
    ])
    stop()
  })
})
