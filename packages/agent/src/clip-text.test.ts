import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clipEnd, clipStart } from './clip-text.ts'

// U+1F600 is two UTF-16 code units, so a cap can land between them.
const EMOJI = '\u{1F600}'

describe('clipStart', () => {
  it('matches slice when the cap falls between whole characters', () => {
    assert.equal(clipStart('hello world', 5), 'hello')
    assert.equal(clipStart('hello', 5), 'hello')
    assert.equal(clipStart('hello', 99), 'hello')
    assert.equal(clipStart(`ab${EMOJI}cd`, 4), `ab${EMOJI}`)
    assert.equal(clipStart('hello', 0), '')
  })

  it('drops the whole character rather than keep half a surrogate pair', () => {
    const clipped = clipStart(`ab${EMOJI}cd`, 3)
    assert.equal(clipped, 'ab')
    assert.equal(clipped.isWellFormed(), true)
    assert.equal(`ab${EMOJI}cd`.slice(0, 3).isWellFormed(), false)
  })

  it('leaves an already lone surrogate alone: it has no pair to split', () => {
    assert.equal(clipStart('ab\uD83Dcd', 3), 'ab\uD83D')
  })
})

describe('clipEnd', () => {
  it('matches a negative slice when the cap falls between whole characters', () => {
    assert.equal(clipEnd('hello world', 5), 'world')
    assert.equal(clipEnd('hello', 99), 'hello')
    assert.equal(clipEnd(`ab${EMOJI}cd`, 4), `${EMOJI}cd`)
    assert.equal(clipEnd('hello', 0), '')
  })

  it('drops the whole character rather than keep half a surrogate pair', () => {
    const clipped = clipEnd(`ab${EMOJI}cd`, 3)
    assert.equal(clipped, 'cd')
    assert.equal(clipped.isWellFormed(), true)
    assert.equal(`ab${EMOJI}cd`.slice(-3).isWellFormed(), false)
  })
})
