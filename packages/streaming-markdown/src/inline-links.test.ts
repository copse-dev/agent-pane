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

  it('parses empty inline destinations (#485, #487)', () => {
    assert.equal(
      renderInlineLinks('[link]()', new Map(), (label) => label),
      '<a href="" target="_blank" rel="noopener noreferrer" data-browser-link="true">link</a>',
    )
    assert.equal(
      renderInlineLinks('[]()', new Map(), (label) => label),
      '<a href="" target="_blank" rel="noopener noreferrer" data-browser-link="true"></a>',
    )
  })

  it('rejects nested links inside link labels (#518)', () => {
    assert.equal(
      renderInlineSpans('[foo [bar](/uri)](/uri)'),
      '[foo <a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true">bar</a>](/uri)',
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
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true"><img src="moon.jpg" alt="moon" data-md-rendered="1" /></a>',
    )
  })

  it('parses links whose labels contain rendered <code> spans', () => {
    assert.equal(
      renderInlineLinks('[<code>docs/foo.md</code>](docs/foo.md)', new Map(), (label) => label),
      '<a href="docs/foo.md" class="workspace-markdown-link" data-workspace-link="true"><code>docs/foo.md</code></a>',
    )
  })
})
