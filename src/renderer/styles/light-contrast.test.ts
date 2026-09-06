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
  it('never paints --text-on-accent onto an --accent background', () => {
    // In light, `--accent` is `color-mix(in srgb, var(--accent-color) 30%, black)`
    // while `--text-on-accent` stays a dark grey — 1.24:1 with the shipped accent.
    // `--accent-fill` keeps the raw hue in both themes, which is what dark label
    // text is designed to sit on (`.ui-btn-primary` is the reference recipe).
    const offenders = stylesheets()
      .flatMap(({ file, css }) => rules(file, css))
      .filter(
        (rule) =>
          /background(-color)?:\s*var\(--accent\)/.test(rule.body) &&
          rule.body.includes('var(--text-on-accent)'),
      )
      .map((rule) => `${rule.file}:${String(rule.line)} ${rule.selector}`)
    assert.deepEqual(
      offenders,
      [],
      `these rules put dark label text on the light theme's dark --accent; use --accent-fill:\n${offenders.join('\n')}`,
    )
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
