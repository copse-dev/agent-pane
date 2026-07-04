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

  it('accepts a destination on the line after the colon (#597, spec #198)', () => {
    const refs = parseLinkReferenceDefinitions('[foo]:\n/url\n\n[foo]\n')
    assert.equal(lookupLinkReference(refs, 'foo')?.href, '/url')
  })

  it('accepts a multi-line title (#597, spec #196)', () => {
    const refs = parseLinkReferenceDefinitions("[foo]: /url '\ntitle\nline1\n'\n\n[foo]\n")
    assert.equal(lookupLinkReference(refs, 'foo')?.href, '/url')
    assert.equal(lookupLinkReference(refs, 'foo')?.title, '\ntitle\nline1\n')
  })

  it('rejects trailing content after the title (#597, spec #209)', () => {
    const refs = parseLinkReferenceDefinitions('[foo]: /url "title" ok\n')
    assert.equal(lookupLinkReference(refs, 'foo'), undefined)
  })

  it('still accepts an empty angle-bracket destination (spec #200)', () => {
    const refs = parseLinkReferenceDefinitions('[foo]: <>\n\n[foo]\n')
    assert.equal(lookupLinkReference(refs, 'foo')?.href, '')
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
