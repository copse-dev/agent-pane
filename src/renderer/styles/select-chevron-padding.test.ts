// Contract test for issue #2437 ("Dropdown chevrons have no right-hand
// padding").
//
// forms.css draws a custom chevron for every `<select>` via `--select-chevron`
// instead of the platform glyph, explicitly so it lines up with the model
// picker's own chevron: same 12px lucide glyph, inset `--spacing-sm` off the
// control's right edge (`.model-picker-field .model-picker-trigger` reaches
// the same inset through its own `padding: var(--spacing-sm)` plus
// `justify-content: space-between`). `padding-right` is then widened by twice
// that inset plus the glyph width so the longest option text stays clear of
// it. happy-dom has no layout or background-image engine, so none of that is
// observable from a component test — this pins the declarations themselves.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const STYLES = resolve(process.cwd(), 'src/renderer/styles')
const FORMS_CSS = 'src/renderer/styles/global/forms.css'

function stylesheets(): { file: string; css: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) return walk(path)
      return entry.name.endsWith('.css') ? [path] : []
    })
  return walk(STYLES).map((file) => ({
    file: relative(process.cwd(), file),
    // Comments are stripped first: they can carry braces and selector-like
    // text, either of which would confuse the flat-rule scan below.
    css: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  }))
}

interface Rule {
  file: string
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
    found.push({ file, selector, body: match[2] ?? '' })
  }
  return found
}

/**
 * True when one comma-separated part of `selector` targets the bare `select`
 * element — `select`, `select:focus`, `select[disabled]`, `label select`,
 * `.ui-field select` — as opposed to a class that merely contains the word,
 * such as `.vnc-machine-select` or `.roadmap-status-select`.
 */
function targetsSelectElement(selector: string): boolean {
  return selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => /(?:^|[\s>+~])select(?:$|[\s:.[])/.test(part))
}

describe('select chevron keeps its right-hand padding (#2437)', () => {
  const sheets = stylesheets()
  const allRules = sheets.flatMap(({ file, css }) => rules(file, css))
  const selectRules = allRules.filter((rule) => targetsSelectElement(rule.selector))
  const canonical = selectRules.find(
    (rule) => rule.file === FORMS_CSS && rule.selector === 'select',
  )

  it('draws the shared chevron --spacing-sm off the right edge in forms.css', () => {
    assert.ok(canonical, `${FORMS_CSS} must have a bare \`select { … }\` rule`)
    assert.match(
      canonical.body,
      /background-image:\s*var\(--select-chevron\)/,
      'select must paint the shared chevron token, not the platform glyph',
    )
    assert.match(
      canonical.body,
      /background-position:\s*right var\(--spacing-sm\) center/,
      "the chevron must sit --spacing-sm off the control's right edge, matching the model picker chevron",
    )
    assert.match(
      canonical.body,
      /background-size:\s*12px 12px/,
      'the chevron glyph must stay the same 12px size as the model picker chevron',
    )
    assert.match(
      canonical.body,
      /padding-right:\s*calc\(2 \* var\(--spacing-sm\) \+ 12px\)/,
      'padding-right must clear the inset twice plus the glyph width so option text never runs under it',
    )
  })

  it('has no per-surface select rule that redraws the chevron without the same padding', () => {
    // forms.css itself is trusted to manage this cascade (its own base
    // `input, textarea, select` rule sets a plain `padding` that the later,
    // more specific chevron rule intentionally narrows to `padding-right`).
    // Every *other* file's rule is a candidate regression: a compound
    // selector like `.settings-content label select` outranks the bare
    // `select` rule on specificity alone, so a `padding` / `padding-inline` /
    // `padding-right` there silently wins the cascade and shrinks the
    // chevron's clearance back down — exactly what happened in `settings.css`
    // (#2437: it read fine as "give fields breathing room" and quietly ate
    // forms.css's `padding-right`).
    const offenders = selectRules
      .filter((rule) => rule.file !== FORMS_CSS)
      .filter((rule) =>
        /background-position|background-image|padding-right|padding-inline(?!-start)|padding\s*:/.test(
          rule.body,
        ),
      )
    assert.deepEqual(
      offenders.map((rule) => `${rule.file}: ${rule.selector}`),
      [],
      'a select rule outside forms.css must not override the chevron position/image/padding-right — that is exactly how #2437 (chevron flush against the edge, or text running under it) would come back for one surface while the rest stayed fixed',
    )
  })
})
