// Contract tests for surfaces that used to box, tint or shout on their own terms
// (docs/ui-taste.md → "Settings rows sit on the page", "Notices are flat plates too",
// "Labels outside the kit follow the kit" and "Empty states are upright").
//
// Most of these only render in states the demo build cannot reach (a stopped
// scheduler, a staged-diff conflict, a review finding), so a screenshot would not
// catch a frame or a caps rule creeping back. happy-dom has no cascade worth
// trusting, so pin each rule at the stylesheet level.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const GLOBAL = resolve(process.cwd(), 'src/renderer/styles/global')

type Rule = { file: string; selectors: string[]; body: string }

/** Innermost `selector { … }` rules of every global sheet, comments stripped. */
const allRules: Rule[] = readdirSync(GLOBAL)
  .filter((file) => file.endsWith('.css'))
  .flatMap((file) => {
    const css = readFileSync(resolve(GLOBAL, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => {
      const head = (match[1] ?? '').trim()
      if (!head || head.startsWith('@')) return []
      const selectors = head.split(',').map((part) => part.trim().replace(/\s+/g, ' '))
      return [{ file, selectors, body: match[2] ?? '' }]
    })
  })

/** Every rule whose selector list names `selector` exactly; at least one must exist. */
function rulesFor(selector: string): Rule[] {
  const found = allRules.filter((rule) => rule.selectors.includes(selector))
  assert.ok(found.length > 0, `no rule for ${selector}`)
  return found
}

/** A border or outline side declared with something other than 0 / none. */
const drawsBorder = (body: string): boolean =>
  /(^|[;\s])border(-(top|right|bottom|left))?(-width)?\s*:(?!\s*(0|0px|none)\b)/.test(body)

const where = (rule: Rule): string => `${rule.file}: ${rule.selectors.join(', ')}`

describe('Settings rows sit on the page', () => {
  const ROWS = [
    '.sources-row',
    '.mcp-curated-row',
    '.plugin-catalog-card',
    '.automation-row',
    '.automation-permission-row',
    '.automation-permission-row:hover',
    '.acp-agent-card',
    '.classifier-local-row',
    '.openai-connection-card',
    '.usage-worth-card',
    '.about-licenses-list',
    '.plugin-settings-fold .apple-development-panel',
    '.environment-setup-list',
    '.remote-folder-list',
    '.ssh-host-row',
    '.mobile-companion-device-row',
  ]

  for (const selector of ROWS) {
    it(`${selector} draws no frame`, () => {
      for (const rule of rulesFor(selector)) {
        assert.equal(drawsBorder(rule.body), false, `${where(rule)} draws a border`)
        assert.doesNotMatch(rule.body, /border-color\s*:/, `${where(rule)} tints a border`)
      }
    })
  }

  it('keeps no fill on a row, except the plates that carry a state or a scroll region', () => {
    const PLATES = new Set(['.remote-folder-list', '.automation-permission-row:hover'])
    for (const selector of ROWS.filter((row) => !PLATES.has(row))) {
      for (const rule of rulesFor(selector)) {
        assert.doesNotMatch(
          rule.body,
          /background(-color)?\s*:(?!\s*(none|transparent)\b)/,
          `${where(rule)} paints a fill`,
        )
      }
    }
  })

  it('keeps the remote folder picker visible as a well inside its dialog', () => {
    const fill = (selector: string): string | undefined =>
      rulesFor(selector)
        .map((rule) => /background:\s*([^;]+);/.exec(rule.body)?.[1]?.trim())
        .find((value) => value !== undefined)
    const well = fill('.remote-folder-list')
    assert.ok(well, '.remote-folder-list has no fill')
    assert.notEqual(well, fill('.remote-folder-dialog'), 'the well matches the dialog it sits in')
  })

  it('keeps the Apple Development card above a conversation, where it is not a Settings row', () => {
    // The conversation mounts the same panel (conversation.ts), so only the
    // Settings copy may drop the frame.
    const [card] = rulesFor('.apple-development-panel')
    assert.ok(card)
    assert.equal(drawsBorder(card.body), true, `${where(card)} lost its frame`)
    assert.match(card.body, /background:\s*var\(--bg-elevated\)/, where(card))
    const [host] = rulesFor('.plugin-settings-fold .apple-development-host')
    assert.ok(host)
    assert.match(host.body, /margin:\s*0\b/, `${where(host)} keeps the conversation inset`)
  })

  it('leaves a focus ring room when a row clips its overflow', () => {
    // A row without side padding puts the focus ring of a control at its edge
    // outside its box, where `overflow: hidden` cuts it. `overflow: clip` with a
    // margin keeps the ring; Chromium drops a calc() or var() margin as invalid.
    for (const selector of ROWS) {
      for (const rule of rulesFor(selector)) {
        if (selector === '.remote-folder-list') continue
        assert.doesNotMatch(
          rule.body,
          /overflow(-x|-y)?\s*:\s*hidden/,
          `${where(rule)} clips rings`,
        )
        if (/overflow\s*:\s*clip/.test(rule.body)) {
          const margin = /overflow-clip-margin:\s*(\d+(?:\.\d+)?)px\s*;/.exec(rule.body)
          assert.ok(margin, `${where(rule)} needs a plain-length overflow-clip-margin`)
          assert.ok(Number(margin[1]) >= 2, `${where(rule)} clip margin is narrower than a ring`)
        }
      }
    }
  })

  it('lines an open licence up with its name', () => {
    for (const selector of ['.about-license-summary', '.about-license-body']) {
      const [rule] = rulesFor(selector)
      assert.ok(rule)
      assert.match(rule.body, /padding:\s*\S+ 0( \S+)?;/, `${where(rule)} keeps a side inset`)
    }
  })

  it('draws no rules between licences or environment setup rows', () => {
    for (const rule of allRules) {
      for (const selector of rule.selectors) {
        if (/\.(about-licenses-list > li|environment-setup-row) \+/.test(selector)) {
          assert.equal(drawsBorder(rule.body), false, `${where(rule)} draws a row rule`)
        }
      }
    }
  })

  it('marks a blocked automation or a hooks warning with the warning plate, not a tinted frame', () => {
    for (const selector of ['.automation-row-blocked', '.sources-row-warning']) {
      const [rule] = rulesFor(selector)
      assert.ok(rule)
      assert.match(rule.body, /--sev:\s*var\(--warning\)/, where(rule))
      assert.match(rule.body, /var\(--callout-plate-fill\)/, where(rule))
      assert.doesNotMatch(
        rule.body,
        /border-color\s*:/,
        `${where(rule)} tints a frame it no longer has`,
      )
    }
  })
})

describe('notices sit on the shared flat callout plate', () => {
  const NOTICES: [selector: string, sev: 'warning' | 'danger'][] = [
    ['.activity-automation-notice', 'danger'],
    ['.activity-issue-detail', 'warning'],
    ['.automation-attention', 'warning'],
    ['.automation-scheduler-notice', 'danger'],
    ['.vnc-network-warning', 'warning'],
    ['.diff-conflict-banner', 'warning'],
    ['.setup-context-advisory', 'warning'],
    ['.mcp-trust-banner', 'warning'],
  ]

  for (const [selector, sev] of NOTICES) {
    it(`${selector} picks --${sev} and mixes the plate, with no frame or fallback hex`, () => {
      const owning = rulesFor(selector).filter((rule) => /background\s*:/.test(rule.body))
      assert.equal(owning.length, 1, `${selector} should have one rule that paints it`)
      const [rule] = owning
      assert.ok(rule)
      assert.match(rule.body, new RegExp(`--sev:\\s*var\\(--${sev}\\)`), where(rule))
      assert.match(
        rule.body,
        /background:\s*color-mix\(in srgb, var\(--sev\) var\(--callout-plate-fill\), var\(--bg-elevated\)\)/,
        where(rule),
      )
      assert.equal(drawsBorder(rule.body), false, `${where(rule)} draws a border`)
      assert.doesNotMatch(rule.body, /var\(--[\w-]+,\s*#/, `${where(rule)} keeps a fallback hex`)
    })
  }
})

describe('labels outside the kit follow the kit', () => {
  const LABELS = [
    '.plugin-panel-badge',
    '.review-finding-severity',
    '.review-finding-class',
    '.roadmap-review-applied-badge',
    '.branch-picker-default-badge',
    '.memories-row-taint',
  ]

  for (const selector of LABELS) {
    it(`${selector} is sentence case at the badge size`, () => {
      for (const rule of rulesFor(selector)) {
        assert.doesNotMatch(rule.body, /text-transform:\s*uppercase/, where(rule))
        assert.doesNotMatch(rule.body, /letter-spacing\s*:/, where(rule))
      }
      const [own] = rulesFor(selector).filter((rule) => /font-size\s*:/.test(rule.body))
      assert.ok(own, `${selector} sets no font size`)
      assert.match(own.body, /font-size:\s*var\(--badge-font-size\)/, where(own))
      // ::first-letter only applies to a block container.
      assert.match(own.body, /display:\s*inline-block/, where(own))
      const [first] = rulesFor(`${selector}::first-letter`)
      assert.ok(first)
      assert.match(first.body, /text-transform:\s*uppercase/, where(first))
    })
  }

  it('shows the Browse publisher as its name, and the image chip detail without caps', () => {
    for (const selector of [
      '.plugin-catalog-publisher',
      ".image-chip[data-detail='low']::after",
      ".image-chip[data-detail='high']::after",
    ]) {
      for (const rule of rulesFor(selector)) {
        assert.doesNotMatch(rule.body, /text-transform:\s*uppercase/, where(rule))
        assert.doesNotMatch(rule.body, /letter-spacing\s*:/, where(rule))
      }
    }
  })
})

describe('empty states are upright', () => {
  const EMPTY = [
    '.code-block-output-empty',
    '.tool-result-empty',
    '.hook-test-stream pre.hook-test-stream-empty',
    '.plugin-chips-empty',
    '.acp-diff-eof',
    '.usage-estimated',
    '.frontier-tooltip .tt-status',
  ]

  for (const selector of EMPTY) {
    it(`${selector} is not italic`, () => {
      for (const rule of rulesFor(selector)) {
        assert.doesNotMatch(rule.body, /font-style:\s*italic/, where(rule))
      }
    })
  }
})
