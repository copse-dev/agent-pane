// Contract tests for accent rails. Two rules, and the second is the reason the
// first one still has anything left to guard:
//
//   1. A rail never bends around a corner.
//   2. A rail is structure, not decoration — the list is closed.
//
// Copse used to draw ten of these across six stylesheets for three unrelated
// jobs: containment ("this block is a different kind of content"), selection
// ("this row is current") and nesting ("these rows are children of that one").
// One device serving three meanings is what made it read as repetition rather
// than as signal. `prototypes/side-highlight` took the first two away —
// containment became a plate (flat for the agent's own prose, hatched for
// Copse's commentary on a turn) and selection became the fill alone — and left
// the third, where a line down the edge is literally what a nesting guide is.
//
// A selection/status rail is a slim bar on one inline edge of a row — either a
// `border-left` or an inset shadow with a horizontal offset (`inset 2px 0 0`).
// Both are clipped to the element's `border-radius`, so putting one on a rounded
// box makes the bar bow around the corners it meets. That curved-bar-on-a-rounded-
// card look is one the house does not ship (see `docs/ui-taste.md` → "Accent rails
// never curve"), and no harness catches it on its own:
// happy-dom has no layout, and a screenshot diff only shows it once someone has
// already shipped it. So pin the rule at the stylesheet level.
//
// The rule is per-edge, not per-element: a rail on the inline-start edge only
// requires the *start* corners to be square. `border-radius: 0 6px 6px 0` — square
// where the bar lands, rounded away from it — is the sanctioned way to keep a
// rounded card and a straight rail, and is what @copse/streaming-markdown does for
// blockquotes.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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

type Rule = { file: string; line: number; selector: string; body: string }

/**
 * Flat `selector { … }` rules. `[^{}]` on both sides means an at-rule wrapper can
 * never match as a whole, so the scan descends into `@media`/`@supports` and
 * yields the real rules inside them.
 */
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

/**
 * Split on `separator` outside parens. Both callers need this: `calc(1px + 2px)`
 * is one value, and the commas inside `:is(.a, .b)` do not start a new selector.
 */
function split(input: string, separator: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of input.trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (separator.test(char) && depth === 0) {
      if (current) out.push(current)
      current = ''
    } else current += char
  }
  if (current) out.push(current)
  return out
}

const values = (input: string): string[] => split(input, /\s/)

const isZero = (value: string): boolean => /^0(px|%|r?em)?$/.test(value)

/**
 * `border-radius` corners as `[top-left, top-right, bottom-right, bottom-left]`,
 * expanded from the 1–4 value shorthand. Only the horizontal radii matter here:
 * a corner with a zero horizontal radius is square where an inline rail lands.
 */
function corners(shorthand: string): string[] {
  const horizontal = values((shorthand.split('/')[0] ?? '').trim())
  const [a = '0', b = a, c = a, d = b] = horizontal
  return [a, b, c, d]
}

type Side = 'start' | 'end'
/** Corner slots each inline edge touches. */
const SIDE_CORNERS: Record<Side, number[]> = { start: [0, 3], end: [1, 2] }

/**
 * The subject compound of each comma-branch: its classes and pseudo-element. A
 * branch whose subject carries no class (`input`, `.image-chip img`) yields an
 * empty set, and the join below drops those rather than matching everything.
 */
function subjects(selector: string): { classes: Set<string>; pseudo: string }[] {
  return split(selector, /,/).map((branch) => {
    const last =
      branch
        .trim()
        .split(/[\s>+~]+/)
        .filter(Boolean)
        .at(-1) ?? ''
    return {
      classes: new Set((last.match(/\.[A-Za-z0-9_-]+/g) ?? []).map((name) => name.slice(1))),
      pseudo: last.match(/::[a-z-]+/)?.[0] ?? '',
    }
  })
}

/**
 * A rail on one inline edge, or null. CSS-triangle borders are not rails.
 *
 * `kind` separates the two ways one can be drawn, which the second test needs:
 * an inset shadow paints over the element and can only be a marker, while a
 * border occupies layout space and is also how this app walls one pane off from
 * the next (`.sidebar`, `.pane-left`, `.settings-nav`, `.diff-file-list`).
 */
function rail(body: string): { side: Side; kind: 'border' | 'shadow'; declaration: string } | null {
  const border = body.match(/border-(left|right|inline-start|inline-end)(?:-width)?:\s*([^;]+)/)
  if (border) {
    const isTriangle =
      /border-top:[^;]*transparent/.test(body) && /border-bottom:[^;]*transparent/.test(body)
    const width = values(border[2] ?? '')[0] ?? '0'
    if (!isTriangle && !isZero(width) && width !== 'none') {
      const side: Side = /left|start/.test(border[1] ?? '') ? 'start' : 'end'
      return {
        side,
        kind: 'border',
        declaration: `border-${border[1] ?? ''}: ${(border[2] ?? '').trim()}`,
      }
    }
  }
  // An inset shadow is a rail when it is offset horizontally with no blur: a
  // ring (`inset 0 0 0 1px`) has a zero offset and follows the radius evenly.
  const shadow = body.match(/box-shadow:\s*([^;]+)/)
  const inset = (shadow?.[1] ?? '').match(/inset\s+(-?[\d.]+)px\s+0(?:px)?\s+0(?:px)?(?!\s*[\d.])/)
  if (inset) {
    const offset = Number(inset[1])
    if (offset !== 0) {
      return {
        side: offset > 0 ? 'start' : 'end',
        kind: 'shadow',
        declaration: `box-shadow: ${(shadow?.[1] ?? '').trim()}`,
      }
    }
  }
  return null
}

/** `.msg` is the stem of `.msg-error`: a modifier applied on top of a base class. */
const isStemOf = (stem: string, name: string): boolean => name.startsWith(`${stem}-`)

/**
 * Every element still allowed to carry a rail, keyed by a class on its subject
 * compound, with the reason it is not decoration. Adding a row here is a design
 * decision, not a fix: a new rail means one more thing in the app that looks
 * like nesting and is not.
 */
const STRUCTURAL_RAILS: { class: string; why: string }[] = [
  {
    class: 'tool-rollup-body',
    why: 'nesting guide — the bar says "these rows are children of that one"',
  },
  {
    class: 'subagent-timeline',
    why: "nesting guide — a subagent's rows hang off the card that spawned it",
  },
  {
    class: 'thread-proposal',
    why: 'a standing offer, marked as an ask rather than as a record; the settled states drop it (docs/proposed-threads.md)',
  },
]

describe('accent rails', () => {
  it('never curves a rail around a rounded corner', () => {
    const all = stylesheets().flatMap(({ file, css }) => rules(file, css))

    // Every rounded corner any element can pick up, keyed by the compound that
    // grants it. The rail and the radius are usually declared in different rules
    // (`.vnc-discovered-port` is rounded; `.vnc-discovered-port.selected` carries
    // the rail), so this has to be a join, not a per-rule check.
    const rounded = all.flatMap((rule) => {
      const shorthand = rule.body.match(/border-radius:\s*([^;]+)/)?.[1]
      if (!shorthand) return []
      const slots = corners(shorthand)
      return subjects(rule.selector).map((subject) => ({
        ...subject,
        rule,
        value: shorthand.trim(),
        sides: (['start', 'end'] as Side[]).filter((side) =>
          SIDE_CORNERS[side].some((slot) => !isZero(slots[slot] ?? '0')),
        ),
      }))
    })

    const violations: string[] = []
    for (const rule of all) {
      const found = rail(rule.body)
      if (!found) continue
      for (const subject of subjects(rule.selector)) {
        if (subject.classes.size === 0) continue
        const curved = rounded.filter(
          (entry) =>
            entry.pseudo === subject.pseudo &&
            entry.sides.includes(found.side) &&
            entry.classes.size > 0 &&
            // A radius reaches this element when its compound is a subset of the
            // rail's (`.vnc-discovered-port` ⊆ `.vnc-discovered-port.selected`),
            // or when it sits on a base class the rail's modifier extends.
            [...entry.classes].every(
              (name) =>
                subject.classes.has(name) ||
                [...subject.classes].some((own) => isStemOf(name, own)),
            ),
        )
        for (const entry of curved) {
          violations.push(
            `${rule.file}:${String(rule.line)} {${rule.selector}} lays a rail on the inline-${found.side} edge\n` +
              `    ${found.declaration}\n` +
              `  but ${entry.rule.file}:${String(entry.rule.line)} {${entry.rule.selector}} rounds that edge\n` +
              `    border-radius: ${entry.value}`,
          )
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      'An accent rail is clipped to the border-radius, so a rounded corner bends it into a curve.\n' +
        'Square the corners the rail touches (`border-radius: 0`, or `0 6px 6px 0` to stay rounded\n' +
        'on the far side), or drop the rail for an even ring (`box-shadow: inset 0 0 0 1px`).\n\n' +
        `${violations.join('\n\n')}\n`,
    )
  })

  it('draws a rail only where it means nesting', () => {
    const strays = stylesheets()
      .flatMap(({ file, css }) => rules(file, css))
      .flatMap((rule) => {
        const found = rail(rule.body)
        if (!found) return []
        // A trailing-edge border is how the app draws the wall between two
        // panes, so it is out of scope here — a marker on that edge is drawn as
        // an inset shadow (which is what `.chat-row.selected` used), and a
        // trailing border on a rounded row is still caught by the curve test.
        if (found.kind === 'border' && found.side === 'end') return []
        // One branch may be structural while another is not, so judge each.
        return subjects(rule.selector)
          .filter(
            (subject) =>
              subject.classes.size > 0 &&
              !STRUCTURAL_RAILS.some((allowed) => subject.classes.has(allowed.class)),
          )
          .map(
            () => `${rule.file}:${String(rule.line)} {${rule.selector}}\n    ${found.declaration}`,
          )
      })

    assert.deepEqual(
      strays,
      [],
      'A rail on the inline edge of a block now means one thing: these rows are children of that\n' +
        "one. Containment takes a plate instead — flat for the agent's own prose, hatched for\n" +
        'Copse annotating its own turn (styles/global/base.css holds the tuning) — and a\n' +
        'selected list row takes the full-bleed fill alone. If this really is nesting, add it to\n' +
        'STRUCTURAL_RAILS above with the reason.\n\n' +
        `${strays.join('\n\n')}\n`,
    )
  })
})
