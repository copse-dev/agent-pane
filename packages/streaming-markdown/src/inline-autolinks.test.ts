import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderInlineSpans } from './inline-spans.ts'

describe('renderAngleAutolinks', () => {
  it('renders bare scheme and email autolinks', () => {
    assert.equal(
      renderInlineSpans('<https://foo.bar>'),
      '<a href="https://foo.bar">https://foo.bar</a>',
    )
    assert.equal(
      renderInlineSpans('<foo@bar.example>'),
      '<a href="mailto:foo@bar.example">foo@bar.example</a>',
    )
  })

  it('escapes & in autolink text exactly once (spec 595)', () => {
    assert.equal(
      renderInlineSpans('<https://foo.bar/test?q=hello&id=22&boolean>'),
      '<a href="https://foo.bar/test?q=hello&amp;id=22&amp;boolean">https://foo.bar/test?q=hello&amp;id=22&amp;boolean</a>',
    )
  })
})
