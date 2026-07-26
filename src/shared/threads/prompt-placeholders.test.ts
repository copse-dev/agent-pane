import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PASTE_PLACEHOLDER, stripPastePlaceholders } from './prompt-placeholders.ts'

describe('stripPastePlaceholders', () => {
  it('leaves a prompt without placeholders alone (beyond trimming)', () => {
    assert.equal(stripPastePlaceholders('  Fix the login bug  '), 'Fix the login bug')
  })

  it('removes a placeholder and the double space it leaves behind', () => {
    assert.equal(
      stripPastePlaceholders(`Look at ${PASTE_PLACEHOLDER} and explain`),
      'Look at and explain',
    )
  })

  it('removes several placeholders in one prompt', () => {
    const content = `${PASTE_PLACEHOLDER} vs ${PASTE_PLACEHOLDER} — which?`
    assert.equal(stripPastePlaceholders(content), 'vs — which?')
  })

  it('does not collapse the line structure of a multi-line prompt', () => {
    const content = `First line ${PASTE_PLACEHOLDER}\nSecond line`
    assert.equal(stripPastePlaceholders(content), 'First line\nSecond line')
  })

  it('returns empty for a prompt that was nothing but a paste', () => {
    assert.equal(stripPastePlaceholders(PASTE_PLACEHOLDER), '')
  })
})
