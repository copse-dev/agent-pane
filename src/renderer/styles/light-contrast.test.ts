// Contract tests for the light theme's readable-colour rules (issues #2486, #2488).
//
// Both defects this pins were invisible to every harness the repo has. happy-dom
// has no cascade or colour engine, and a screenshot diff only catches an
// unreadable control once someone has already shipped it — and then only if a
// reviewer looks at the light theme, which is not the default. So the rules are
// pinned at the stylesheet level, and the contrast is *computed* rather than
// eyeballed: these tests resolve the same `color-mix()` the browser would and
// measure the WCAG ratio.
//
// The two rules are different in kind:
//
//  1. A structural one (#2488). `--accent` and `--accent-fill` are the same colour
//     in the dark theme and deliberately diverge in light, where `--accent` becomes
//     a 30%-of-black derivation for small text, links and borders. Painting that
//     dark derivation behind `--text-on-accent` (a dark grey) gives 1.24:1 — which
//     is what the roadmap Save button and the Changes badge were doing. Eleven
//     rules had drifted onto it. The fill token is `--accent-fill`.
//
//  2. A numeric one (#2486). The vendored markdown stylesheet ships a VS Code
//     Dark+ `.hljs-*` palette and expects the host to override it; nothing did, so
//     Dark+ token colours were painted on a near-white code surface. The override
//     now lives in `global/markdown.css`, and this test holds it to AA.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'

const STYLES = resolve(process.cwd(), 'src/renderer/styles')

/** Every renderer stylesheet, comments stripped (they carry braces and selectors). */
function stylesheets(): { file: string; css: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) return walk(path)
      return entry.name.endsWith('.css') ? [path] : []
    })
  return walk(STYLES).map((file) => ({
    file: relative(process.cwd(), file),
    css: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  }))
}

interface Rule {
  file: string
  line: number
  selector: string
  body: string
}

/** Flat `selector { … }` rules; `[^{}]` on both sides descends into at-rules. */
function rules(file: string, css: string): Rule[] {
  const found: Rule[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css))) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ')
    if (!selector || selector.startsWith('@')) continue
    found.push({
      file,
      line: css.slice(0, match.index).split('\n').length,
      selector,
      body: match[2] ?? '',
    })
  }
  return found
}

// ---------------------------------------------------------------------------
// Colour maths. Enough of CSS Color 4 to resolve the tokens these rules use:
// `color-mix(in srgb, …)` interpolates in gamma-encoded sRGB, which is plain
// componentwise interpolation of the 0-255 channels.
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number]

function parseHex(value: string): Rgb {
  const hex = value.trim().replace('#', '')
  // `#abc` expands to `#aabbcc`; an 8-digit form drops its alpha (the contrast
  // maths below is opaque-over-opaque). Rewritten per character rather than by
  // spreading the string, which lints as a Unicode hazard.
  const full =
    hex.length === 3
      ? hex.replace(/./g, (char) => `${char}${char}`)
      : hex.length === 8
        ? hex.slice(0, 6)
        : hex
  assert.equal(full.length, 6, `expected a hex colour, got ${value}`)
  const channel = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16)
  return [channel(0), channel(2), channel(4)]
}

function mix(top: Rgb, portion: number, bottom: Rgb): Rgb {
  const at = (index: 0 | 1 | 2): number =>
    Math.round(top[index] * portion + bottom[index] * (1 - portion))
  return [at(0), at(1), at(2)]
}

function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const srgb = value / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  assert.ok(lighter !== undefined && darker !== undefined)
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG 2.2 AA for body text. Code spans are small text, so this is the right bar. */
const AA_BODY_TEXT = 4.5

/**
 * The light theme's code-block background, derived the way the browser does.
 *
 * `conversation.css` maps the markdown package's `--sm-code-bg` onto
 * `--bg-elevated`, and light re-derives that surface as the whole-app tint mixed
 * into a light grey. Reading the numbers out of the stylesheets rather than
 * hard-coding them is deliberate: change the tint or the light boost and this
 * test re-measures against the new surface instead of silently vouching for the
 * old one.
 */
function lightCodeBackground(): Rgb {
  const tokens = readFileSync(resolve(STYLES, 'tokens.css'), 'utf8')
  const themes = readFileSync(resolve(STYLES, 'themes.css'), 'utf8')
  const read = (css: string, name: string, pattern: RegExp): string => {
    const found = pattern.exec(css)?.[1]
    assert.ok(found, `could not read ${name} — the token derivation changed, re-check this test`)
    return found
  }
  const hue = read(tokens, '--tint-hue', /--tint-hue:\s*(#[0-9a-fA-F]{3,8})/)
  const amount = Number.parseFloat(read(tokens, '--tint-amount', /--tint-amount:\s*([\d.]+)%/))
  const boost = Number.parseFloat(
    read(themes, '--tint-light-boost', /--tint-light-boost:\s*([\d.]+)/),
  )
  const base = read(
    themes,
    'light --bg-elevated',
    /--bg-elevated:\s*color-mix\(in srgb, var\(--tint-hue\) var\(--tint-amount-light\), (#[0-9a-fA-F]{3,8})\)/,
  )
  return mix(parseHex(hue), (amount * boost) / 100, parseHex(base))
}

/** The `.hljs-*` colours the light theme declares in `global/markdown.css`. */
function lightSyntaxColours(): { selector: string; colour: string }[] {
  const css = readFileSync(resolve(STYLES, 'global/markdown.css'), 'utf8')
  const found: { selector: string; colour: string }[] = []
  for (const rule of rules('markdown.css', css.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    if (!rule.selector.includes('.hljs-') || !rule.selector.includes("[data-theme='light']"))
      continue
    const colour = /color:\s*(#[0-9a-fA-F]{3,8})/.exec(rule.body)?.[1]
    if (colour) found.push({ selector: rule.selector, colour })
  }
  return found
}

describe('light theme: primary fills use --accent-fill (issue #2488)', () => {
  it('uses the fill tier on the live controls named by the report', () => {
    // In light, `--accent` is `color-mix(in srgb, var(--accent-color) 30%, black)`
    // while `--text-on-accent` stays a dark grey — 1.24:1 with the shipped accent.
    // `--accent-fill` keeps the raw hue in both themes, which is what dark label
    // text is designed to sit on (`.ui-btn-primary` is the reference recipe).
    const targets = [
      '.titlebar-btn-badge',
      '.memories-btn-primary',
      '.queued-action.queued-send-now',
      '.usage-plan-signin-btn',
      '.automation-save-btn',
    ]
    const declarations = stylesheets().flatMap(({ file, css }) => rules(file, css))
    for (const target of targets) {
      const rule = declarations.find(
        (candidate) =>
          candidate.selector.includes(target) && candidate.body.includes('var(--text-on-accent)'),
      )
      assert.ok(rule, `missing rule for ${target}`)
      assert.match(
        rule.body,
        /background(?:-color)?:\s*var\(--accent-fill\)/,
        `${rule.file}:${String(rule.line)} ${target} must use the readable fill tier`,
      )
      assert.ok(rule.body.includes('var(--text-on-accent)'), `${target} must keep its label tier`)
    }
  })

  it('keeps --accent-fill undarkened in light, so the recipe still works', () => {
    // The fix depends on light NOT redefining --accent-fill the way it redefines
    // --accent. If it ever does, every primary button silently regresses.
    const themes = readFileSync(resolve(STYLES, 'themes.css'), 'utf8')
    const lightBlock = /\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(themes)?.[1]
    assert.ok(lightBlock, 'could not find the light theme block')
    assert.ok(
      !/^\s*--accent-fill:/m.test(lightBlock),
      'light redefines --accent-fill; primary-button contrast must be re-measured if that is intended',
    )
  })

  it('gives the roadmap Save button and Changes badge fill/label pair >= 4.5:1 in both themes', () => {
    // The two controls the report named by appearance. Both take their colour
    // from `.memories-btn-primary` (the roadmap Save button's primary class,
    // `roadmap-pane.ts`) and `.titlebar-btn-badge` (the sidebar/footer Changes
    // count, `panel-mode-controls.ts`) — and both declare
    // `background: var(--accent-fill); color: var(--text-on-accent)` directly
    // (memories.css, titlebar.css). Neither token is redefined by either theme
    // block (pinned above and below), so one measurement of the shipped default
    // pair stands for both controls in both themes — this computes the actual
    // WCAG ratio rather than trusting the token names, so a future change to
    // either hex still has to clear AA.
    const tokens = readFileSync(resolve(STYLES, 'tokens.css'), 'utf8')
    const themes = readFileSync(resolve(STYLES, 'themes.css'), 'utf8')
    const read = (css: string, name: string, pattern: RegExp): string => {
      const found = pattern.exec(css)?.[1]
      assert.ok(found, `could not read ${name} — the token derivation changed, re-check this test`)
      return found
    }
    const accentColor = read(tokens, '--accent-color', /--accent-color:\s*(#[0-9a-fA-F]{3,8})/)
    const textOnAccent = read(tokens, '--text-on-accent', /--text-on-accent:\s*(#[0-9a-fA-F]{3,8})/)

    for (const theme of ['dark', 'light'] as const) {
      const block = new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
        themes,
      )?.[1]
      assert.ok(block, `could not find the ${theme} theme block`)
      assert.ok(
        !/^\s*--accent-fill:/m.test(block) && !/^\s*--text-on-accent:/m.test(block),
        `${theme} redefines --accent-fill or --text-on-accent; re-measure this pair against its own values`,
      )
    }

    const ratio = contrastRatio(parseHex(accentColor), parseHex(textOnAccent))
    assert.ok(
      ratio >= AA_BODY_TEXT,
      `--accent-fill (${accentColor}) / --text-on-accent (${textOnAccent}) must clear ` +
        `${String(AA_BODY_TEXT)}:1 in both themes, measured ${ratio.toFixed(2)}:1`,
    )
  })

  it('would still fail at the pre-fix --accent/--text-on-accent pairing in light (guards the guard)', () => {
    // Mirrors the Dark+ guard below: proves the maths above would have caught
    // the actual bug, not just a value that happens to already pass. Before the
    // fix, both controls filled with `--accent` (the light-only 30%-of-black
    // derivation meant for small text/borders) instead of `--accent-fill`.
    const tokens = readFileSync(resolve(STYLES, 'tokens.css'), 'utf8')
    const themes = readFileSync(resolve(STYLES, 'themes.css'), 'utf8')
    const accentColor = /--accent-color:\s*(#[0-9a-fA-F]{3,8})/.exec(tokens)?.[1]
    const textOnAccent = /--text-on-accent:\s*(#[0-9a-fA-F]{3,8})/.exec(tokens)?.[1]
    assert.ok(accentColor && textOnAccent, 'expected default accent/text-on-accent tokens')
    const lightBlock = /\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(themes)?.[1]
    assert.ok(lightBlock, 'could not find the light theme block')
    const percent = /--accent:\s*color-mix\(in srgb, var\(--accent-color\) (\d+)%, black\)/.exec(
      lightBlock,
    )?.[1]
    assert.ok(percent, 'could not read the light --accent derivation — re-check this test')
    const darkenedAccent = mix(parseHex(accentColor), Number(percent) / 100, [0, 0, 0])
    const ratio = contrastRatio(darkenedAccent, parseHex(textOnAccent))
    assert.ok(
      ratio < AA_BODY_TEXT,
      `expected the pre-fix --accent/--text-on-accent pairing to stay unreadable in light, measured ${ratio.toFixed(2)}:1`,
    )
  })
})

// ---------------------------------------------------------------------------
// Change-status colours (issue #3065). The git status letters, the +/- line
// stats, the PR CI dots and the diff editor's washes each carried their own raw
// hex — five different "added" greens — and the letters measured 1.55:1 on the
// light pane. They now bind to tokens, so the contrast is measured on the token
// values each theme actually resolves, on the surfaces the marks sit on.
// ---------------------------------------------------------------------------

/** WCAG 1.4.11: a status dot carries meaning without text, so 3:1. */
const AA_NON_TEXT = 3

/** Custom-property declarations of the first flat `selector { … }` block. */
function declarationsOf(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `could not find ${selector}`)
  const body = css.slice(start, css.indexOf('\n}', start))
  return new Map(
    [...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => [
      match[1] ?? '',
      (match[2] ?? '').trim(),
    ]),
  )
}

type ThemeName = 'dark' | 'light'

/**
 * Resolves a custom property the way the root element would for one theme:
 * the theme block wins over `:root`, and `var()`, `calc()` products and
 * `color-mix(in srgb, …)` are evaluated. A mix with `transparent` is returned
 * with its portion so the caller can composite it over a surface.
 */
function themeResolver(theme: ThemeName): {
  colour: (name: string) => Rgb
  wash: (name: string) => { colour: Rgb; portion: number }
} {
  const strip = (name: string): string =>
    readFileSync(resolve(STYLES, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const root = declarationsOf(strip('tokens.css'), ':root')
  const themed = declarationsOf(strip('themes.css'), `[data-theme='${theme}']`)
  const raw = (name: string): string => {
    const value = themed.get(name) ?? root.get(name)
    assert.ok(value, `${theme} does not resolve ${name}`)
    return value
  }
  const reference = (value: string): string | undefined =>
    /^var\((--[\w-]+)\)$/.exec(value.trim())?.[1]
  const number = (value: string): number => {
    const referenced = reference(value)
    if (referenced) return number(raw(referenced))
    const product = /^calc\((.+?)\s*\*\s*(.+)\)$/.exec(value.trim())
    if (product) return number(product[1] ?? '') * number(product[2] ?? '')
    const parsed = Number.parseFloat(value)
    assert.ok(Number.isFinite(parsed), `could not read a number from ${value}`)
    return parsed
  }
  const mixParts = (value: string): [string, number, string] | null => {
    const found = /^color-mix\(in srgb,\s*(\S+)\s+(.+?),\s*(.+)\)$/.exec(value.trim())
    if (!found) return null
    return [found[1] ?? '', number(found[2] ?? '') / 100, (found[3] ?? '').trim()]
  }
  const colourOf = (value: string): Rgb => {
    const trimmed = value.trim()
    if (trimmed === 'black') return [0, 0, 0]
    if (trimmed === 'white') return [255, 255, 255]
    const referenced = reference(trimmed)
    if (referenced) return colourOf(raw(referenced))
    const parts = mixParts(trimmed)
    if (parts) return mix(colourOf(parts[0]), parts[1], colourOf(parts[2]))
    return parseHex(trimmed)
  }
  return {
    colour: (name): Rgb => colourOf(raw(name)),
    wash: (name): { colour: Rgb; portion: number } => {
      const parts = mixParts(raw(name))
      assert.ok(parts && parts[2] === 'transparent', `${name} must be a wash over transparent`)
      return { colour: colourOf(parts[0]), portion: parts[1] }
    },
  }
}

/** Surfaces a change row sits on: the side panes at rest and under the pointer. */
const PANE_SURFACES = ['--bg-base', '--bg-elevated', '--bg-hover'] as const

describe('change-status colours are tokens that stay readable (issue #3065)', () => {
  const sheet = (name: string): Rule[] =>
    rules(
      name,
      readFileSync(resolve(STYLES, 'global', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
    )
  const colourOf = (found: Rule[], selector: string, property: string): string => {
    const rule = found.find((candidate) => candidate.selector.split(/,\s*/).includes(selector))
    assert.ok(rule, `missing a rule for ${selector}`)
    const value = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(rule.body)?.[1]?.trim()
    assert.ok(value, `${rule.file}:${String(rule.line)} ${selector} declares no ${property}`)
    return value
  }

  it('binds every change mark to the shared tokens rather than a raw hue', () => {
    const layout = sheet('layout.css')
    const expected: [Rule[], string, string, string][] = [
      [layout, '.git-change-status-modified', 'color', 'var(--change-modified)'],
      [layout, '.git-change-status-added', 'color', 'var(--change-added)'],
      [layout, '.git-change-status-untracked', 'color', 'var(--change-added)'],
      [layout, '.git-change-status-deleted', 'color', 'var(--change-deleted)'],
      [layout, '.git-change-status-removed', 'color', 'var(--change-deleted)'],
      [layout, '.git-change-status-renamed', 'color', 'var(--change-renamed)'],
      [layout, '.pr-list-ci-success', 'background', 'var(--success)'],
      [layout, '.pr-list-ci-failure', 'background', 'var(--error)'],
      [layout, '.pr-list-ci-pending', 'background', 'var(--warning)'],
      [layout, '.git-diff-editor-wrap .line-insert', 'background-color', 'var(--diff-insert)'],
      [layout, '.git-diff-editor-wrap .gutter-insert', 'background-color', 'var(--diff-insert)'],
      [layout, '.git-diff-editor-wrap .line-delete', 'background-color', 'var(--diff-delete)'],
      [layout, '.git-diff-editor-wrap .gutter-delete', 'background-color', 'var(--diff-delete)'],
      [sheet('tool-cards.css'), '.tool-stat-add', 'color', 'var(--change-added)'],
      [sheet('tool-cards.css'), '.tool-stat-del', 'color', 'var(--change-deleted)'],
      [sheet('composer-extras.css'), '.follow-up-stat-add', 'color', 'var(--change-added)'],
      [sheet('composer-extras.css'), '.follow-up-stat-del', 'color', 'var(--change-deleted)'],
    ]
    for (const [found, selector, property, value] of expected) {
      assert.equal(
        colourOf(found, selector, property).replace(/\s*!important$/, ''),
        value,
        selector,
      )
    }
  })

  for (const theme of ['dark', 'light'] as const) {
    const tokens = themeResolver(theme)

    it(`keeps change letters and +/- stats at text contrast in ${theme}`, () => {
      const failures: string[] = []
      for (const token of [
        '--change-added',
        '--change-modified',
        '--change-deleted',
        '--change-renamed',
      ]) {
        for (const surface of PANE_SURFACES) {
          const ratio = contrastRatio(tokens.colour(token), tokens.colour(surface))
          if (ratio < AA_BODY_TEXT) failures.push(`${token} on ${surface}: ${ratio.toFixed(2)}:1`)
        }
        // A selected row keeps its letter legible as a mark, if not as body text:
        // dark's selection wash is light enough to pull the letters toward 4:1.
        const selected = contrastRatio(tokens.colour(token), tokens.colour('--bg-selected'))
        if (selected < AA_NON_TEXT)
          failures.push(`${token} on --bg-selected: ${selected.toFixed(2)}:1`)
      }
      assert.deepEqual(failures, [], `${theme}: change marks fall below their bar`)
    })

    it(`keeps PR CI dots at non-text contrast in ${theme}`, () => {
      const failures: string[] = []
      for (const token of ['--success', '--error', '--warning']) {
        for (const surface of [...PANE_SURFACES, '--bg-selected']) {
          const ratio = contrastRatio(tokens.colour(token), tokens.colour(surface))
          if (ratio < AA_NON_TEXT) failures.push(`${token} on ${surface}: ${ratio.toFixed(2)}:1`)
        }
      }
      assert.deepEqual(failures, [], `${theme}: CI dots fall below ${String(AA_NON_TEXT)}:1`)
    })

    it(`keeps code readable on the stacked diff washes in ${theme}`, () => {
      // Monaco's own editor surface and default foreground for `vs` / `vs-dark`.
      // A changed character carries both the line wash and the char wash.
      const editor: Rgb = theme === 'light' ? [255, 255, 254] : [30, 30, 30]
      const code: Rgb = theme === 'light' ? [0, 0, 0] : [212, 212, 212]
      for (const token of ['--diff-insert', '--diff-delete']) {
        const { colour, portion } = tokens.wash(token)
        const stacked = mix(colour, portion, mix(colour, portion, editor))
        const ratio = contrastRatio(code, stacked)
        assert.ok(
          ratio >= AA_BODY_TEXT,
          `${theme}: code on ${token} is ${ratio.toFixed(2)}:1 — the wash is too strong`,
        )
      }
    })
  }

  it('would have failed on the raw light-pane hues it replaced (guards the guard)', () => {
    const surface = themeResolver('light').colour('--bg-elevated')
    for (const colour of ['#e2b340', '#73c991', '#75beff', '#3dd68c', '#f07178']) {
      assert.ok(
        contrastRatio(parseHex(colour), surface) < AA_NON_TEXT,
        `${colour} was expected to be unreadable on the light pane`,
      )
    }
  })
})

describe('light theme: syntax highlighting is readable (issue #2486)', () => {
  it('overrides every .hljs- token the vendored Dark+ palette defines', () => {
    // The package ships a Dark+ palette and documents that the host should
    // override it. A version bump that adds a token would otherwise reintroduce a
    // dark-only colour on a near-white surface with nothing to catch it.
    const require_ = createRequire(resolve(process.cwd(), 'package.json'))
    const vendored = readFileSync(
      require_.resolve('@copse/streaming-markdown/styles/default.css'),
      'utf8',
    )
    const classesIn = (css: string): Set<string> =>
      new Set([...css.matchAll(/\.(hljs-[a-z_]+)/g)].map((match) => match[1] ?? ''))
    const ours = classesIn(
      readFileSync(resolve(STYLES, 'global/markdown.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
    )
    const missing = [...classesIn(vendored)].filter((name) => !ours.has(name)).sort()
    assert.deepEqual(
      missing,
      [],
      `the vendored Dark+ palette colours these tokens and the light theme does not: ${missing.join(', ')}`,
    )
  })

  it('clears AA for body text on the light code background', () => {
    const background = lightCodeBackground()
    const colours = lightSyntaxColours()
    assert.ok(colours.length >= 8, `expected the light palette, found ${String(colours.length)}`)
    const failures = colours
      .map((entry) => ({ ...entry, ratio: contrastRatio(parseHex(entry.colour), background) }))
      .filter((entry) => entry.ratio < AA_BODY_TEXT)
      .map((entry) => `${entry.colour} (${entry.ratio.toFixed(2)}:1) — ${entry.selector}`)
    assert.deepEqual(
      failures,
      [],
      `these light syntax colours fall below ${String(AA_BODY_TEXT)}:1 on the code surface:\n${failures.join('\n')}`,
    )
  })

  it('would have failed on the Dark+ palette it replaced', () => {
    // Guards the guard: if the derivation above ever resolves to something
    // implausible, this catches it. Every Dark+ token measured under 3:1 on the
    // light surface, which is why the issue was filed.
    const background = lightCodeBackground()
    const darkPlus = ['#6a9955', '#569cd6', '#ce9178', '#b5cea8', '#dcdcaa', '#4ec9b0', '#9cdcfe']
    for (const colour of darkPlus) {
      assert.ok(
        contrastRatio(parseHex(colour), background) < 3,
        `${colour} was expected to be unreadable on the light code surface`,
      )
    }
  })
})
