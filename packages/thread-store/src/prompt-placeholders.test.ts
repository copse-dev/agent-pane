import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PASTE_PLACEHOLDER,
  replayPromptText,
  stripPastePlaceholders,
} from './prompt-placeholders.ts'

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

describe('replayPromptText', () => {
  it('preserves exact reviewed bytes, including literal placeholders and whitespace', () => {
    const canonical = `  before ${PASTE_PLACEHOLDER} after  \n\n`
    assert.equal(
      replayPromptText(canonical, [{ projection: 'canonical-block' }], undefined),
      canonical,
    )
    assert.equal(replayPromptText(canonical, [], 'canonical-provider'), canonical)
  })

  it('still cleans optimistic placeholders without Main-owned provenance', () => {
    assert.equal(
      replayPromptText(`Look at ${PASTE_PLACEHOLDER}  please`, [{}], undefined),
      'Look at please',
    )
  })
})
