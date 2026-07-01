import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseLinkReferenceDefinitions } from './link-references.ts'
import { renderInlineLinks } from './inline-links.ts'
import { renderInlineSpans } from './inline-spans.ts'

describe('renderInlineLinks', () => {
  it('renders relative inline links with optional titles (#483, #482)', () => {
    assert.equal(
      renderInlineLinks('[link](/uri "title")', new Map(), (label) => label),
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true" title="title">link</a>',
    )
    assert.equal(
      renderInlineLinks('[link](/uri)', new Map(), (label) => label),
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true">link</a>',
    )
  })

  it('resolves reference links and images (#527, #531)', () => {
    const refs = parseLinkReferenceDefinitions('[ref]: /uri\n')
    assert.equal(
      renderInlineSpans('[foo][ref]', refs),
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true">foo</a>',
    )
    assert.equal(
      renderInlineSpans('[![moon](moon.jpg)][ref]', refs),
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true"><img src="moon.jpg" alt="moon" /></a>',
    )
  })
})
