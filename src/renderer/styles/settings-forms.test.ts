// Contract tests for the Settings form/control recipes (#3065).
//
// happy-dom has no layout engine, so geometry (the legend inside its card, equal
// field widths, the header staying put after a sidebar jump) is measured in e2e:
// settings-classifiers.e2e.ts, settings-ssh.e2e.ts, settings-styling.e2e.ts and
// friends. These pin the declarations to the selectors that own them so a
// refactor cannot quietly drop one.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES = resolve(process.cwd(), 'src/renderer/styles/global')
const read = (file: string): string =>
  readFileSync(resolve(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Selector lists of every flat rule, each paired with its body. */
function rules(css: string): Array<{ selectors: string[]; body: string }> {
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (match) => ({
    selectors: (match[1] ?? '')
      .split(/,(?![^(]*\))/)
      .map((selector) => selector.trim().replace(/\s+/g, ' ')),
    body: match[2] ?? '',
  }))
}

function bodiesFor(css: string, selector: string): string {
  return rules(css)
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body)
    .join(';')
}

const settings = read('settings.css')

describe('Settings form recipes', () => {
  it('gives every text-entry input type the field recipe', () => {
    for (const type of ['text', 'password', 'number', 'url', 'email', 'search']) {
      const body = bodiesFor(settings, `.settings-content label input[type='${type}']`)
      assert.match(body, /max-width:\s*480px/, `${type} inputs share the width cap`)
      assert.match(body, /min-height:\s*var\(--action-min-height\)/, `${type} target height`)
      assert.match(body, /padding-inline:\s*var\(--spacing-md\)/, `${type} inputs share the inset`)
    }
  })

  it('paints a rejected field with the error token', () => {
    assert.match(
      bodiesFor(read('forms.css'), "input[aria-invalid='true']"),
      /border-color:\s*var\(--error\)/,
    )
  })

  it('never lets scrollIntoView scroll the dialog chrome', () => {
    for (const selector of ['dialog.settings-overlay', '.settings-body']) {
      assert.match(bodiesFor(settings, selector), /overflow:\s*clip/, `${selector} must clip`)
    }
  })

  it('keeps sidebar sub-headings at the section rows’ weight, arrow on the first line', () => {
    const body = bodiesFor(settings, '.settings-nav-subheading')
    assert.match(body, /font-weight:\s*400/)
    assert.match(body, /align-items:\s*baseline/)
  })

  it('shares the plugin fold’s chevron recipe with every in-form disclosure', () => {
    const summary = bodiesFor(settings, '.settings-disclosure-summary')
    assert.match(summary, /list-style:\s*none/, 'the UA triangle is dropped')
    assert.match(
      bodiesFor(settings, '.settings-disclosure-summary::-webkit-details-marker'),
      /display:\s*none/,
    )
    assert.match(bodiesFor(settings, '.settings-disclosure-chevron'), /transition:\s*transform/)
  })

  it('floats card legends inside the card and keeps Usage’s value map a flat group', () => {
    const cardLegend = rules(settings).find(
      (rule) =>
        rule.selectors.some((selector) => selector.startsWith('.settings-content fieldset:not(')) &&
        /float:\s*left/.test(rule.body),
    )
    assert.ok(cardLegend, 'a nested card legend must be floated into the content box')
    assert.match(
      cardLegend.selectors.join(','),
      /\.usage-section-root > fieldset/,
      'the flat-group list and the card-legend exclusion must agree',
    )
    assert.match(bodiesFor(settings, '.usage-section-root > fieldset'), /background:\s*none/)
    assert.match(
      bodiesFor(settings, '.usage-section-root > fieldset > legend'),
      /font-family:\s*var\(--font-display\)/,
    )
  })
})
