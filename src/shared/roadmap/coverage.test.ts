import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCoverageMatches } from './coverage.ts'

describe('parseCoverageMatches', () => {
  const known = new Set(['item-a', 'item-b'])

  it('parses issue/item/verdict lines and ignores noise', () => {
    const text = [
      'Here are the matches:',
      '#52 item-a likely',
      '41 item-b partial',
      '',
      '```',
      '#99 unknown-id likely',
      'not a match',
    ].join('\n')
    assert.deepEqual(parseCoverageMatches(text, known), [
      { issueNumber: 52, itemId: 'item-a', verdict: 'likely' },
      { issueNumber: 41, itemId: 'item-b', verdict: 'partial' },
    ])
  })

  it('prefers likely over partial for the same issue', () => {
    const text = ['#7 item-a partial', '#7 item-b likely'].join('\n')
    assert.deepEqual(parseCoverageMatches(text, known), [
      { issueNumber: 7, itemId: 'item-b', verdict: 'likely' },
    ])
  })

  it('keeps the first item when verdicts are equal', () => {
    const text = ['#7 item-a likely', '#7 item-b likely'].join('\n')
    assert.deepEqual(parseCoverageMatches(text, known), [
      { issueNumber: 7, itemId: 'item-a', verdict: 'likely' },
    ])
  })

  it('returns empty when nothing parses', () => {
    assert.deepEqual(parseCoverageMatches('Mock response to: coverage', known), [])
  })
})
