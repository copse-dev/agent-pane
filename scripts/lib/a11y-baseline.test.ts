import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  A11Y_BASELINE_PATH,
  a11yBaselineSchema,
  baselineGrowth,
  compareSurface,
  formatA11yBaseline,
  type A11yBaseline,
} from './a11y-baseline.mts'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'

const tracker = 'https://github.com/copse-dev/agent-pane/issues/1369'

function baseline(surfaces: Record<string, Record<string, number>>): A11yBaseline {
  return {
    version: 1,
    surfaces: Object.fromEntries(
      Object.entries(surfaces).map(([surface, rules]) => [
        surface,
        Object.fromEntries(
          Object.entries(rules).map(([rule, count]) => [rule, { count, tracker }]),
        ),
      ]),
    ),
  }
}

describe('compareSurface', () => {
  it('accepts observed counts equal to the baseline', () => {
    const result = compareSurface(baseline({ main: { 'color-contrast': 2 } }), 'main', {
      'color-contrast': 2,
    })
    assert.deepEqual(result, { added: [], stale: [] })
  })

  it('reports a new rule and a grown count as added', () => {
    const result = compareSurface(baseline({ main: { 'color-contrast': 2 } }), 'main', {
      'color-contrast': 3,
      'button-name': 1,
    })
    assert.deepEqual(result.added, [
      { rule: 'button-name', observed: 1, allowed: 0 },
      { rule: 'color-contrast', observed: 3, allowed: 2 },
    ])
    assert.deepEqual(result.stale, [])
  })

  it('reports fixed violations as stale so the baseline must shrink', () => {
    const result = compareSurface(baseline({ main: { 'color-contrast': 2, label: 1 } }), 'main', {
      'color-contrast': 1,
    })
    assert.deepEqual(result.stale, [
      { rule: 'color-contrast', observed: 1, allowed: 2 },
      { rule: 'label', observed: 0, allowed: 1 },
    ])
    assert.deepEqual(result.added, [])
  })

  it('treats an unrecorded surface as having no tolerated violations', () => {
    const result = compareSurface(baseline({}), 'settings', { region: 1 })
    assert.deepEqual(result.added, [{ rule: 'region', observed: 1, allowed: 0 }])
  })

  it('does not read inherited object keys as rules or surfaces', () => {
    const result = compareSurface(baseline({}), 'constructor', { toString: 0 })
    assert.deepEqual(result, { added: [], stale: [] })
  })
})

describe('baselineGrowth', () => {
  it('allows removing entries and lowering counts', () => {
    const base = baseline({ main: { 'color-contrast': 3, label: 1 }, settings: { region: 1 } })
    const head = baseline({ main: { 'color-contrast': 1 } })
    assert.deepEqual(baselineGrowth(base, head), [])
  })

  it('refuses new surfaces, new rules and higher counts', () => {
    const base = baseline({ main: { 'color-contrast': 1 } })
    const head = baseline({
      main: { 'color-contrast': 2, label: 1 },
      settings: { region: 1 },
    })
    assert.deepEqual(baselineGrowth(base, head), [
      'main/color-contrast: grew from 1 to 2',
      'main/label: new baseline entry (1)',
      'settings/region: new baseline entry (1)',
    ])
  })
})

describe('formatA11yBaseline', () => {
  it('sorts keys and drops empty surfaces', () => {
    const text = formatA11yBaseline(baseline({ z: { b: 1, a: 2 }, empty: {}, a: { c: 1 } }))
    const parsed = safeJsonParse(text, decodeWithSchema(a11yBaselineSchema))
    assert.ok(parsed)
    assert.deepEqual(Object.keys(parsed.surfaces), ['a', 'z'])
    assert.deepEqual(Object.keys(parsed.surfaces['z'] ?? {}), ['a', 'b'])
    assert.ok(text.endsWith('}\n'))
  })
})

describe('committed baseline', () => {
  it('parses, links trackers and is already in canonical form', () => {
    const text = readFileSync(A11Y_BASELINE_PATH, 'utf8')
    const parsed = safeJsonParse(text, decodeWithSchema(a11yBaselineSchema))
    assert.ok(parsed, `${A11Y_BASELINE_PATH} must match a11yBaselineSchema`)
    assert.equal(formatA11yBaseline(parsed), text)
  })
})
