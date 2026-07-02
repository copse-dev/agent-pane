import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  lookupLinkReference,
  normalizeReferenceLabel,
  parseInlineLinkDestination,
  parseLinkReferenceDefinitions,
} from './link-references.ts'

describe('parseLinkReferenceDefinitions', () => {
  it('collects definitions and resolves case-insensitive labels (#539)', () => {
    const refs = parseLinkReferenceDefinitions('[bar]: /url "title"\n')
    assert.equal(lookupLinkReference(refs, 'BaR')?.href, '/url')
    assert.equal(lookupLinkReference(refs, 'BaR')?.title, 'title')
  })

  it('keeps the first definition for a duplicate label (#544)', () => {
    const refs = parseLinkReferenceDefinitions('[foo]: /url1\n\n[foo]: /url2\n')
    assert.equal(lookupLinkReference(refs, 'foo')?.href, '/url1')
  })

  it('allows multiline labels (#541)', () => {
    const refs = parseLinkReferenceDefinitions('[Foo\n  bar]: /url\n')
    assert.equal(normalizeReferenceLabel('Foo\n  bar'), normalizeReferenceLabel('Foo bar'))
    assert.equal(lookupLinkReference(refs, 'Baz')?.href, undefined)
    assert.equal(lookupLinkReference(refs, 'Foo bar')?.href, '/url')
  })
})

describe('parseInlineLinkDestination', () => {
  it('parses angle-bracket destinations with spaces (#489)', () => {
    const dest = parseInlineLinkDestination('[x](</my uri>)', 3)
    assert.equal(dest?.href, '/my uri')
  })

  it('rejects destinations containing raw whitespace (#488)', () => {
    assert.equal(parseInlineLinkDestination('[x](/my uri)', 3), null)
  })
})
