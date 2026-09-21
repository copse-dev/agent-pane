import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findMatchOffsets,
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
