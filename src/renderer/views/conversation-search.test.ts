import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSearchIndex,
  findMatchOffsets,
  findSegmentMatches,
  normalizeSearchText,
  mountConversationSearch,
  openConversationSearch,
  closeConversationSearch,
} from './conversation-search.ts'

describe('findMatchOffsets', () => {
  it('finds every occurrence, case-insensitively', () => {
    assert.deepEqual(findMatchOffsets('Foo foo FOO', 'foo'), [0, 4, 8])
  })

  it('returns an empty list for an empty needle', () => {
    assert.deepEqual(findMatchOffsets('anything', ''), [])
  })

  it('returns an empty list when there is no match', () => {
    assert.deepEqual(findMatchOffsets('hello world', 'xyz'), [])
  })

  it('advances past each match so overlaps are not double-counted', () => {
    // "aa" in "aaaa" yields non-overlapping matches at 0 and 2, mirroring find.
    assert.deepEqual(findMatchOffsets('aaaa', 'aa'), [0, 2])
  })

  it('matches across word boundaries and punctuation', () => {
    assert.deepEqual(findMatchOffsets('cmd+f, cmd+f!', 'cmd+f'), [0, 7])
  })
})

describe('openConversationSearch with a prefilled query', () => {
  afterEach(() => {
    closeConversationSearch()
    document.body.replaceChildren()
  })

  it('opens the bar and fills the input with the given query', () => {
    const root = document.createElement('div')
    root.className = 'pane-chat'
    document.body.append(root)
    mountConversationSearch(root)

    openConversationSearch('quoted text')

    const bar = document.querySelector<HTMLElement>('.chat-search')
    const input = document.querySelector<HTMLInputElement>('.chat-search-input')
    assert.ok(bar, 'find bar is mounted')
    assert.equal(bar.hidden, false, 'find bar opens')
    assert.equal(input?.value, 'quoted text')
  })

  it('still opens with no query, leaving any existing input value alone', () => {
    const root = document.createElement('div')
    root.className = 'pane-chat'
    document.body.append(root)
    mountConversationSearch(root)

    openConversationSearch()

    const bar = document.querySelector<HTMLElement>('.chat-search')
    assert.equal(bar?.hidden, false)
  })
})

describe('cross-node search index', () => {
  it('normalises whitespace in queries', () => {
    assert.equal(normalizeSearchText('  ends here.\n\n  Second\tline '), 'ends here. Second line')
  })

  it('matches across formatting and block boundaries, mapping back to raw offsets', () => {
    // <p>Use <b>bold</b>  text</p><p>next</p>
    const index = buildSearchIndex([
      { text: 'Use ', breakBefore: true },
      { text: 'bold', breakBefore: false },
      { text: '  text', breakBefore: false },
      { text: 'next', breakBefore: true },
    ])
    assert.equal(index.text, 'Use bold text next')
    assert.deepEqual(findSegmentMatches(index, 'BOLD text\n\nnext'), [
      { startSegment: 1, startOffset: 0, endSegment: 3, endOffset: 4 },
    ])
    assert.deepEqual(findSegmentMatches(index, 'e b'), [
      { startSegment: 0, startOffset: 2, endSegment: 1, endOffset: 1 },
    ])
  })

  it('does not join words from adjacent blocks', () => {
    const index = buildSearchIndex([
      { text: 'end', breakBefore: true },
      { text: 'start', breakBefore: true },
    ])
    assert.deepEqual(findSegmentMatches(index, 'endstart'), [])
    assert.equal(findSegmentMatches(index, 'end start').length, 1)
  })

  it('returns nothing for a whitespace-only query', () => {
    const index = buildSearchIndex([{ text: 'a b', breakBefore: true }])
    assert.deepEqual(findSegmentMatches(index, '  \n '), [])
  })
})

describe('find bar across rendered formatting', () => {
  afterEach(() => {
    closeConversationSearch()
    document.body.replaceChildren()
  })

  function mountTranscript(html: string): HTMLElement {
    const root = document.createElement('div')
    root.className = 'pane-chat'
    const list = document.createElement('div')
    list.className = 'messages-list'
    list.innerHTML = html
    root.append(list)
    document.body.append(root)
    mountConversationSearch(root)
    return root
  }

  function countText(): string | null | undefined {
    return document.querySelector('.chat-search-count')?.textContent
  }

  it('counts a match spanning bold, inline code and a paragraph break', () => {
    mountTranscript('<p>Run <b>the</b> <code>build</code> now.</p><p>Then ship.</p>')
    openConversationSearch('the build now. Then')
    assert.equal(countText(), '1/1')
  })

  it('starts a new prefilled query from its first match', () => {
    mountTranscript('<p>foo one</p><p>foo two</p><p>foo three</p>')
    openConversationSearch('foo')
    assert.equal(countText(), '1/3')
    const input = document.querySelector<HTMLInputElement>('.chat-search-input')
    assert.ok(input)
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }))
    assert.equal(countText(), '2/3')
    openConversationSearch('foo')
    assert.equal(countText(), '1/3', 'a fresh Search does not keep the previous position')
  })
})
