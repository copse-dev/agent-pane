// Contract test for #3065: dense surfaces use the kit button (`.ui-btn*` in
// `global/ui.css`) instead of their own `*-btn` / `*-btn-primary` stacks.
//
// The rendered result (kit classes on the live buttons, kit radius, row gaps)
// is proven in real Chromium by the focused e2e specs; happy-dom has no cascade
// to measure. This pins the declarations: the legacy hooks may still place a
// button (margin, align-self) but must not paint their own box again, and the
// compact size must stay on the shared tokens.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const GLOBAL = resolve(process.cwd(), 'src/renderer/styles/global')

interface Rule {
  file: string
  selector: string
  body: string
}

function rules(): Rule[] {
  const found: Rule[] = []
  for (const file of readdirSync(GLOBAL).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(resolve(GLOBAL, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      found.push({ file, selector: (match[1] ?? '').trim(), body: match[2] ?? '' })
    }
  }
  return found
}

/** Legacy button hooks that JS/tests may still query, but CSS must not style as a box. */
const LEGACY_HOOKS = [
  '.memories-save-btn',
  '.memories-delete-btn',
  '.memories-cancel-btn',
  '.ports-open-btn',
  '.ports-copy-btn',
  '.ports-kill-btn',
  '.pr-action-btn',
  '.pr-open-external-btn',
  '.pr-open-thread-btn',
  '.pr-new-thread-btn',
  '.card-retry-button',
  '.card-dismiss-button',
  '.automation-add-btn',
  '.automation-save-btn',
  '.automation-cancel-btn',
  '.automation-row-btn',
  '.automation-run-btn',
  '.automation-remove-btn',
  '.usage-plan-signin-btn',
]

/** Retired stacks: no rule may target these at all. */
const RETIRED = ['.memories-btn', '.ports-btn']

const BOX_PAINT = /(?:^|[;\s])(background(?:-color)?|border-radius|padding(?:-[a-z]+)?)\s*:/

function targets(selector: string, hook: string): boolean {
  const escaped = hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?![\\w-])`).test(selector)
}

describe('kit buttons replace bespoke button stacks (#3065)', () => {
  const all = rules()

  it('retires the memories/ports button stacks entirely', () => {
    for (const retired of RETIRED) {
      const offenders = all.filter((rule) =>
        new RegExp(`${retired.replace('.', '\\.')}(?:-[\\w-]+)?(?![\\w-])`).test(rule.selector),
      )
      assert.deepEqual(
        offenders.map((rule) => `${rule.file}: ${rule.selector}`),
        [],
        `${retired}* is gone — use .ui-btn + a variant (+ .ui-btn-compact) instead`,
      )
    }
  })

  it('lets legacy hooks place a button but never paint its box', () => {
    const offenders: string[] = []
    for (const hook of LEGACY_HOOKS) {
      for (const rule of all.filter((candidate) => targets(candidate.selector, hook))) {
        const property = BOX_PAINT.exec(rule.body)?.[1]
        if (property) offenders.push(`${rule.file}: ${rule.selector} declares ${property}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'background / border-radius / padding belong to .ui-btn* — a hook that restates them regrows a bespoke stack',
    )
  })

  it('sizes .ui-btn-compact from tokens and keeps the kit radius and border', () => {
    const compact = all.find(
      (rule) => rule.file === 'ui.css' && rule.selector === '.ui-btn-compact',
    )
    assert.ok(compact, 'ui.css must define .ui-btn-compact')
    assert.match(compact.body, /padding:\s*0 var\(--spacing-[a-z]+\)/)
    assert.match(compact.body, /font-size:\s*var\(--font-size-[a-z]+\)/)
    assert.match(compact.body, /min-height:\s*var\(--spacing-[a-z]+\)/)
    assert.doesNotMatch(compact.body, /\d+px/, 'compact geometry must come from tokens, not px')
    assert.doesNotMatch(
      compact.body,
      /border(?:-radius)?\s*:/,
      'compact is a size, not a shape: the radius and border stay on .ui-btn',
    )
  })

  it('keeps adjacent text buttons on the --spacing-md gap', () => {
    for (const [file, selector] of [
      ['memories.css', '.memories-actions'],
      ['ports.css', '.ports-actions'],
      ['layout.css', '.pr-viewer-actions'],
      ['settings.css', '.automation-row-actions,\n.automation-form-actions'],
    ] as const) {
      const matching = all.filter((rule) => rule.file === file && rule.selector === selector)
      assert.equal(matching.length, 1, `${selector} must be declared once in ${file}`)
      const body = matching[0]?.body ?? ''
      const gaps = [...body.matchAll(/(?:^|[;\s])gap:\s*([^;]+);/g)].map((match) => match[1])
      assert.deepEqual(gaps, ['var(--spacing-md)'], `${selector} gap must be --spacing-md, once`)
    }
    for (const selector of ['.roadmap-form .memories-actions', '.roadmap-review-row-actions']) {
      const rule = all.find((candidate) => candidate.selector === selector)
      assert.ok(rule, `roadmap.css must still wrap ${selector}`)
      assert.doesNotMatch(rule.body, /(?:^|[;\s])gap:/, `${selector} inherits the --spacing-md gap`)
    }
  })
})
