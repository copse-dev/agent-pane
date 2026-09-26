// Contract tests for badges: a label on the thing, not a shouted status
// (docs/ui-taste.md → "Badges are labels").
//
//   1. Status hues mean status. `--warning` / `--error` / `--success` / `--danger`
//      on a badge say "this is how the thing is doing"; `--accent` is interaction
//      emphasis plus the one documented "experimental" exception. None of them is
//      a palette for telling categories apart. Settings used to paint every
//      project-scope row in `--warning` beside a neutral "user" one, and Roadmap
//      coloured the `project` category in the same hue as the `blocked` status
//      badge sitting in the same row — two colour codes nobody could read.
//   2. One shape. Settings' chips disagreed on case (shouted caps next to
//      sentence case), corner (full pill next to `--radius`), size, and weight.
//      `.ui-badge` (global/ui.css) and the `--badge-*` tokens own that recipe,
//      so a chip class adds a colour or a width bound — never its own shape.
//
// happy-dom has no cascade worth trusting and a screenshot only shows a stray
// colour once it has shipped, so pin both rules at the stylesheet level. The
// e2e specs that capture these surfaces measure the rendered result.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES = resolve(process.cwd(), 'src/renderer/styles')

/** The stylesheets that own Settings' chips and the Roadmap row badges. */
const BADGE_SHEETS = ['global/settings.css', 'global/mcp.css', 'global/roadmap.css'] as const

type Rule = { file: string; selector: string; body: string }

/** Flat `selector { … }` rules, comments stripped (they carry braces and selectors). */
function rules(file: string): Rule[] {
  const css = readFileSync(resolve(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Rule[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ')
    if (!selector || selector.startsWith('@')) continue
    found.push({ file, selector, body: match[2] ?? '' })
  }
  return found
}

const allRules = BADGE_SHEETS.flatMap((file) => rules(file))

/** A badge or chip rule: some class on the selector names one. */
const isBadgeRule = (selector: string): boolean => /\.[\w-]*(badge|chip|-tag)\b/.test(selector)

/** `--warning`, `--error`, `--success`, `--danger`, or any `--accent*` token. */
const usesSignalToken = (body: string): boolean =>
  /var\(--(warning|error|success|danger|accent[\w-]*)\b/.test(body)

/**
 * Every badge/chip rule still allowed to paint with a status or accent token, and
 * why that colour is a status (or the documented accent case) rather than a
 * category. Adding a row here is a design decision: it is one more place where a
 * reader has to learn what the colour means.
 */
const SIGNAL_BADGES: { selector: string; why: string }[] = [
  // Settings → Providers
  {
    selector: '.provider-chip.active',
    why: 'the selected provider chip — a control, and selection is interaction emphasis',
  },
  { selector: '.provider-chip-dot', why: 'configured/connected status dot' },
  {
    selector: '.provider-privacy-badge.zdr, .provider-privacy-badge.local',
    why: 'data policy: prompts are not retained',
  },
  { selector: '.provider-privacy-badge.trains', why: 'data policy: may train on your data' },
  { selector: '.provider-privacy-badge.unknown', why: 'data policy: unknown retention' },
  // Settings → Customise (sources lists, worktrees)
  { selector: '.sources-badge-warning', why: 'authoring warning, overridden, uncommitted, …' },
  { selector: '.sources-badge-error', why: 'skipped file or runtime failure' },
  { selector: '.sources-badge-unsandboxed', why: 'hook runs outside the project sandbox' },
  {
    selector: '.sources-badge-active',
    why: 'nested instruction file the latest turn selected (docs/ui-taste.md → "Sources lists")',
  },
  { selector: '.sources-badge-untrusted', why: 'instruction file inert until trusted' },
  {
    selector:
      '.sources-badge-untrusted.sources-badge-btn:hover, .sources-badge-untrusted.sources-badge-btn:focus-visible',
    why: 'hover wash of the untrusted badge, which is also its fix',
  },
  // Settings → Plugins
  {
    selector: '.plugin-badge-experimental',
    why: 'the documented "experimental" accent exception (docs/ui-taste.md)',
  },
  // Settings → MCP
  {
    selector: '.mcp-origin-chip.mcp-origin-project',
    why: 'a server that arrived with the checkout: executable config the user did not choose',
  },
  // Roadmap rows
  { selector: '.roadmap-status-badge.is-blocked', why: 'status: blocked' },
  { selector: '.roadmap-status-badge.is-conflicts', why: 'status: conflicts' },
  { selector: '.roadmap-issue-chip', why: 'a link to the pinned issue — interaction emphasis' },
  { selector: '.roadmap-thread-chip:hover', why: 'hover on a link to the thread' },
  { selector: '.roadmap-complexity-badge.is-medium', why: 'estimated-effort severity' },
  { selector: '.roadmap-complexity-badge.is-high', why: 'estimated-effort severity' },
  { selector: '.roadmap-fit-badge.is-likely', why: 'model verdict' },
  { selector: '.roadmap-fit-badge.is-partial', why: 'model verdict' },
  { selector: '.roadmap-fit-badge.is-unlikely', why: 'model verdict' },
  { selector: '.roadmap-review-badge.is-resolved', why: 'review verdict' },
  { selector: '.roadmap-review-badge.is-likely', why: 'review verdict' },
  { selector: '.roadmap-review-badge.is-partial', why: 'review verdict' },
  { selector: '.roadmap-review-live-badge', why: 'a review is running now' },
  { selector: '.roadmap-review-applied-badge', why: 'review outcome applied' },
]

/** Chip classes whose shape comes from `.ui-badge`, rendered with that class too. */
const RECIPE_CHIPS = [
  'sources-badge',
  'provider-form-tag',
  'provider-privacy-badge',
  'mcp-origin-chip',
  'plugin-badge-stable',
  'plugin-badge-experimental',
] as const

/** Declarations the badge recipe owns; a chip class restating one forks the shape. */
const RECIPE_PROPERTIES = [
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-transform',
  'border-radius',
  'padding',
] as const

describe('badge colour means status', () => {
  it('colours a badge only with a status it reports (or the documented accent case)', () => {
    const allowed = new Set(SIGNAL_BADGES.map((entry) => entry.selector))
    const offenders = allRules
      .filter((rule) => isBadgeRule(rule.selector) && usesSignalToken(rule.body))
      .filter((rule) => !allowed.has(rule.selector))
      .map((rule) => `${rule.file}: ${rule.selector}`)
    assert.deepEqual(
      offenders,
      [],
      'a badge painted with a status or accent token must report that status — ' +
        'a category, scope, or kind stays neutral (docs/ui-taste.md → "Badges are labels")',
    )
  })

  it('keeps the allowlist honest: every entry still names a coloured rule', () => {
    const coloured = new Set(
      allRules.filter((rule) => usesSignalToken(rule.body)).map((rule) => rule.selector),
    )
    const stale = SIGNAL_BADGES.map((entry) => entry.selector).filter((s) => !coloured.has(s))
    assert.deepEqual(stale, [], 'drop allowlist rows whose rule no longer uses a signal token')
  })

  it('leaves the neutral labels neutral', () => {
    for (const neutral of [
      '.ui-badge',
      '.roadmap-category-badge',
      '.plugin-badge',
      '.plugin-badge-first-party',
      '.plugin-badge-user, .plugin-badge-cursor',
    ]) {
      const rule = [...rules('global/ui.css'), ...allRules].find((r) => r.selector === neutral)
      assert.ok(rule, `${neutral} exists`)
      assert.equal(usesSignalToken(rule.body), false, `${neutral} stays neutral`)
    }
    for (const gone of [
      '.sources-badge-project',
      '.sources-badge-auto',
      '.plugin-badge-stable',
      '.roadmap-category-badge.is-bug',
      '.roadmap-category-badge.is-feature',
      '.roadmap-category-badge.is-project',
    ]) {
      assert.equal(
        allRules.some((rule) => rule.selector.split(/,\s*/).includes(gone)),
        false,
        `${gone} carried a colour code and should not come back`,
      )
    }
  })
})

describe('one badge shape', () => {
  it('defines the recipe once, from the badge tokens, in sentence case', () => {
    const tokens = readFileSync(resolve(STYLES, 'tokens.css'), 'utf8')
    for (const token of [
      '--badge-font-size',
      '--badge-font-weight',
      '--badge-radius',
      '--badge-padding-block',
      '--badge-padding-inline',
    ]) {
      assert.match(tokens, new RegExp(`${token}:`), `${token} is defined`)
    }
    const ui = rules('global/ui.css')
    const base = ui.find((rule) => rule.selector === '.ui-badge')
    assert.ok(base)
    assert.match(base.body, /font-size:\s*var\(--badge-font-size\)/)
    assert.match(base.body, /font-weight:\s*var\(--badge-font-weight\)/)
    assert.match(base.body, /border-radius:\s*var\(--badge-radius\)/)
    assert.match(base.body, /text-transform:\s*none/)
    const firstLetter = ui.find((rule) => rule.selector === '.ui-badge::first-letter')
    assert.ok(firstLetter)
    assert.match(firstLetter.body, /text-transform:\s*uppercase/)
    // Full rounding is the action recipe; a badge is a label, not a button.
    assert.doesNotMatch(tokens, /--badge-radius:\s*var\(--action-radius\)/)
  })

  it('never lets a chip class restate the shape the recipe owns', () => {
    const forks: string[] = []
    for (const rule of allRules) {
      const classes = rule.selector.match(/\.[\w-]+/g) ?? []
      if (!classes.some((c) => RECIPE_CHIPS.some((chip) => c === `.${chip}`))) continue
      for (const property of RECIPE_PROPERTIES) {
        if (new RegExp(`(^|[;\\s])${property}\\s*:`).test(rule.body)) {
          forks.push(`${rule.file}: ${rule.selector} { ${property} }`)
        }
      }
    }
    assert.deepEqual(forks, [], 'shape lives on .ui-badge; a chip class adds colour only')
  })
})
