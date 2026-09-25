// Contract tests for the #3065 VNC-panel and off-token dialog fixes.
//
// happy-dom has no layout engine, so the rendered results (colours, wrapping,
// a closed dialog's box) are measured by the e2e/demo specs named below. These
// tests pin the *declarations* those results depend on, so a later edit cannot
// quietly bring a raw pixel scale, a pink status hue or an unscoped dialog
// `display` back:
//   - tests/e2e/vnc-viewer.e2e.ts, tests/demo/vnc-saved-login.demo.ts
//   - tests/demo/app-run.demo.ts, tests/demo/apple-development-target.demo.ts
//   - tests/e2e/onboarding.e2e.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES = resolve(process.cwd(), 'src/renderer/styles/global')
const read = (file: string): string =>
  readFileSync(resolve(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

interface Declaration {
  selector: string
  property: string
  value: string
}

// Innermost rules only: a selector cannot contain a brace, so a rule nested in
// an at-rule (`@container … { .x { … } }`) is read as `.x`.
function declarations(css: string): Declaration[] {
  const result: Declaration[] = []
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (rule[1] ?? '').trim()
    for (const line of (rule[2] ?? '').split(';')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      result.push({
        selector,
        property: line.slice(0, colon).trim(),
        value: line.slice(colon + 1).trim(),
      })
    }
  }
  return result
}

const SPACING_PROPERTY = /^(?:padding|margin|gap|row-gap|column-gap|font-size)(?:-[a-z-]+)?$/

describe('dialog and panel spacing tokens (#3065)', () => {
  for (const file of ['app-run.css', 'apple-development.css']) {
    it(`${file} spaces and sizes type from tokens, not raw pixels`, () => {
      const raw = declarations(read(file)).filter(
        ({ property, value }) => SPACING_PROPERTY.test(property) && /\d+(?:\.\d+)?px/.test(value),
      )
      assert.deepEqual(
        raw.map(({ selector, property, value }) => `${selector} { ${property}: ${value} }`),
        [],
        'use --spacing-* / --font-size-* (compose with calc() when needed) so --ui-scale reaches the surface',
      )
      // The shorthand hides a size inside a font stack; spell it out instead.
      assert.equal(
        declarations(read(file)).some(({ property }) => property === 'font'),
        false,
        `${file} uses the font shorthand`,
      )
    })
  }

  it('lets #app-run-dialog inherit the shared dialog chrome', () => {
    const own = declarations(read('app-run.css')).filter(
      ({ selector }) => selector === '#app-run-dialog',
    )
    for (const property of ['background', 'border', 'border-radius', 'padding', 'color']) {
      assert.equal(
        own.some((declaration) => declaration.property === property),
        false,
        `#app-run-dialog re-declares ${property}; forms.css \`dialog\` owns it`,
      )
    }
    const base = declarations(read('forms.css')).filter(({ selector }) => selector === 'dialog')
    const value = (property: string): string | undefined =>
      base.find((declaration) => declaration.property === property)?.value
    assert.equal(value('background'), 'var(--bg-elevated)')
    assert.equal(value('border-radius'), 'var(--radius-lg)')
    assert.equal(value('padding'), 'var(--spacing-xl)')
  })

  it('scopes the onboarding dialog display to [open]', () => {
    const unscoped = declarations(read('onboarding.css')).filter(
      ({ selector, property }) =>
        property === 'display' &&
        selector.split(',').some((part) => /\.onboarding-overlay(?!\S*\[open\])/.test(part)),
    )
    assert.deepEqual(unscoped, [], 'a <dialog> display must be scoped to [open] (ui-taste.md)')
  })
})

describe('VNC panel severity and fields (#3065)', () => {
  const vnc = declarations(read('vnc.css'))
  const value = (selector: string, property: string): string | undefined =>
    vnc.find(
      (declaration) => declaration.selector === selector && declaration.property === property,
    )?.value

  it('marks authentication required with a status hue, not the accent', () => {
    assert.equal(value('.vnc-auth-panel', '--sev'), 'var(--warning)')
    assert.equal(value(".vnc-status[data-kind='error']", '--sev'), 'var(--error)')
    assert.equal(value('.vnc-auth-title', 'color'), 'var(--sev)')
    // One gutter for both surfaces: the auth panel and the status line share
    // the dot column instead of an icon column beside a dot column.
    assert.equal(
      value('.vnc-auth-panel,\n.vnc-status', 'grid-template-columns'),
      '6px minmax(0, 1fr)',
    )
    assert.equal(
      value(
        '.vnc-auth-panel > :not(.vnc-status-dot),\n.vnc-status > :not(.vnc-status-dot)',
        'grid-column',
      ),
      '2',
      'everything but the dot sits in the body column',
    )
    assert.equal(
      vnc.some(({ selector }) => selector.includes('vnc-auth-icon')),
      false,
      'the lock-icon gutter was replaced by the shared status dot',
    )
  })

  it('keeps authentication fields in the interface font', () => {
    // The system font is for the password mask alone (Pliant's bullet reads as
    // a period); the placeholder text goes back to the interface font.
    for (const { selector } of vnc.filter(({ value: v }) => v.includes('system-ui'))) {
      assert.match(
        selector,
        /^\.vnc(?:-setup)?-password-input(?:,\s*\.vnc(?:-setup)?-password-input)*$/,
        selector,
      )
    }
    assert.equal(
      value(
        '.vnc-password-input::placeholder,\n.vnc-setup-password-input::placeholder',
        'font-family',
      ),
      'var(--font-family)',
    )
    const mono = vnc.filter(
      ({ property, value: v }) => property === 'font-family' && v.includes('--font-mono'),
    )
    for (const { selector } of mono) {
      assert.doesNotMatch(selector, /vnc-auth-input|password|username|target/, selector)
    }
  })

  it('stacks the saved-login action instead of squeezing the copy beside it', () => {
    assert.equal(value('.vnc-saved-login', 'flex-direction'), 'column')
    assert.notEqual(value('.vnc-saved-login-copy', 'overflow-wrap'), 'anywhere')
  })
})
