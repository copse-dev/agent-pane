import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { disclosureSummary } from './disclosure-summary.ts'

describe('disclosureSummary', () => {
  it('renders the label followed by an outline chevron', () => {
    const summary = disclosureSummary('Connection options')

    assert.equal(summary.tagName, 'SUMMARY')
    assert.equal(summary.className, 'settings-disclosure-summary')
    assert.equal(summary.textContent, 'Connection options')
    const chevron = summary.lastElementChild
    assert.ok(chevron, 'the summary ends with its chevron')
    assert.equal(chevron.getAttribute('data-icon'), 'chevron-down')
    assert.match(chevron.getAttribute('class') ?? '', /\bui-icon\b/)
    assert.match(chevron.getAttribute('class') ?? '', /\bsettings-disclosure-chevron\b/)
  })
})
