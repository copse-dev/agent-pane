// Contract test: every renderer font-size follows the interface scale (#3065).
//
// Settings → Appearance "Interface scale" (and ⌘+/−) sets `--ui-scale`, and the
// type tokens in tokens.css multiply by it. A raw `font-size: 11px` bypasses
// that, so badges, eyebrows and labels stayed small while everything around
// them grew. happy-dom cannot resolve `calc(… * var(--ui-scale))`, so this pins
// the declarations instead; the computed sizes at 125% are asserted in
// tests/e2e/ui-scale.e2e.ts.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const RENDERER = resolve(ROOT, 'src/renderer')
const TOKENS = 'src/renderer/styles/tokens.css'

/**
 * Declarations that deliberately stay in fixed pixels, keyed by
 * `file :: selector :: value`. Keep it short and give every entry a reason.
 */
const ALLOWED_FIXED: ReadonlyMap<string, string> = new Map([
  [
    'src/renderer/styles/global/layout.css :: .project-menu-btn,\n.project-new-thread-btn :: 18px',
    'Icon-only buttons in the unscaled 24px --projects-action-size box with a fixed 12px icon. ' +
      'These are not flex containers, so font-size only sets the line box the icon sits on; ' +
      'scaling it past the box would push the icon off-centre at 150%.',
  ],
])

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}

// Comments go first (they can quote a stale `font-size: 11px`); their newlines
// stay so the reported line numbers still match the file.
const stripComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))

/** The selector of the rule whose body contains `index` (flat or one level nested). */
function enclosingSelector(css: string, index: number): string {
  const open = css.lastIndexOf('{', index)
  const before = Math.max(css.lastIndexOf('}', open - 1), css.lastIndexOf('{', open - 1))
  return css.slice(before + 1, open).trim()
}

// A pixel length that is multiplied by the scale is fine; any other px is not.
const SCALED_PX = /calc\(\s*[\d.]+px\s*\*\s*var\(--ui-scale\)\s*\)/g
const RAW_PX = /(?<![\w-])[\d.]+px\b/

interface FixedFontSize {
  /** `file :: selector :: value`, the ALLOWED_FIXED key. */
  key: string
  /** `file:line  selector { value`, for the failure message. */
  where: string
}

function fixedFontSizes(file: string): FixedFontSize[] {
  const rel = relative(ROOT, file)
  const css = stripComments(readFileSync(file, 'utf8'))
  const found: FixedFontSize[] = []
  for (const match of css.matchAll(/(?<![\w-])(font-size|font)\s*:\s*([^;}]+)/g)) {
    const value = (match[2] ?? '').trim()
    if (!RAW_PX.test(value.replace(SCALED_PX, ''))) continue
    const selector = enclosingSelector(css, match.index)
    const line = String(css.slice(0, match.index).split('\n').length)
    found.push({
      key: `${rel} :: ${selector} :: ${value}`,
      where: `${rel}:${line}  ${selector} { ${value}`,
    })
  }
  return found
}

const files = cssFiles(RENDERER).filter((file) => relative(ROOT, file) !== TOKENS)

describe('renderer font sizes follow --ui-scale (#3065)', () => {
  it('scans the renderer stylesheets', () => {
    assert.ok(files.length > 20, `expected the renderer stylesheets, found ${String(files.length)}`)
  })

  it('uses a scaled type token (or calc with --ui-scale) instead of raw px', () => {
    const offenders = files
      .flatMap(fixedFontSizes)
      .filter(({ key }) => !ALLOWED_FIXED.has(key))
      .map(({ where }) => where)
    assert.deepEqual(
      offenders,
      [],
      'Raw px font sizes ignore Settings → Appearance interface scale. Use ' +
        '--font-size-3xs/2xs/xs/sm/base/md/lg, or calc(Npx * var(--ui-scale)) for a one-off size.',
    )
  })

  it('keeps every allowlisted fixed size in use', () => {
    const present = new Set(files.flatMap(fixedFontSizes).map(({ key }) => key))
    for (const key of ALLOWED_FIXED.keys()) {
      assert.ok(present.has(key), `stale ALLOWED_FIXED entry: ${key}`)
    }
  })

  it('defines every type-ramp token as a multiple of --ui-scale', () => {
    const tokens = stripComments(readFileSync(resolve(ROOT, TOKENS), 'utf8'))
    const ramp = [...tokens.matchAll(/(--font-size-[\w-]+)\s*:\s*([^;]+);/g)]
    assert.ok(ramp.length >= 7, 'expected the --font-size-* ramp in tokens.css')
    for (const [, name, value] of ramp) {
      assert.match(
        value ?? '',
        /^calc\(\s*[\d.]+px\s*\*\s*var\(--ui-scale\)\s*\)$/,
        `${name ?? ''} must be calc(Npx * var(--ui-scale))`,
      )
    }
  })
})
