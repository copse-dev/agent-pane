import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPLORE_TOOL_NAMES,
  EXPLORE_WITHOUT_READ_NUDGE_THRESHOLD,
  hasOpenTodos,
  isDuplicateExploreCall,
  nextConsecutiveExploreWithoutRead,
  toolCallFingerprint,
  normalizeExploreArgs,
} from './agent-loop-guards.ts'

describe('toolCallFingerprint', () => {
  it('treats equivalent list_dir args as the same key', () => {
    const a = toolCallFingerprint('list_dir', normalizeExploreArgs('list_dir', { path: '.' }))
    const b = toolCallFingerprint('list_dir', normalizeExploreArgs('list_dir', {}))
    assert.equal(a, b)
  })
})

describe('EXPLORE_TOOL_NAMES', () => {
  it('includes explore (#1433: it was missing, so the guard never fired for it)', () => {
    assert.equal(EXPLORE_TOOL_NAMES.has('explore'), true)
  })
})

describe('isDuplicateExploreCall', () => {
  it('detects a repeated explore call', () => {
    const fp = toolCallFingerprint('list_dir', { path: '.' })
    assert.equal(isDuplicateExploreCall('list_dir', { path: '.' }, [fp]), true)
  })

  it('ignores non-explore tools', () => {
    const fp = toolCallFingerprint('run_shell', { command: 'npm test' })
    assert.equal(isDuplicateExploreCall('run_shell', { command: 'npm test' }, [fp]), false)
  })

  it('detects a byte-for-byte repeated `explore` call (#1433 item 1)', () => {
    const args = { query: 'how does the urlInput keydown handler work', paths: ['url-bar.ts'] }
    const fp = toolCallFingerprint('explore', normalizeExploreArgs('explore', args))
    assert.equal(isDuplicateExploreCall('explore', args, [fp]), true)
  })

  it('treats the seven #1433 paraphrases of the same request as repeats', () => {
    // Reproduces the issue's real run: seven differently-worded queries, all
    // against the same file, all asking for the same urlInput keydown
    // handler code. Only the first three are quoted in the issue; the rest
    // paraphrase the same request the way a stuck model would. All seven
    // share a 4-word core ("urlinput", "keydown", "handler", "enter") once
    // tokenized — every one of them scores exactly the
    // EXPLORE_QUERY_JACCARD_DUPLICATE_THRESHOLD / MIN_SHARED_EXPLORE_QUERY_TOKENS
    // boundary or above against the first (see that constant's comment for
    // the computed pairwise numbers); this is not a coincidence of wording,
    // it is what "asking for the same thing seven different ways" looks like
    // once tokenized.
    const paths = ['src/renderer/views/url-bar.ts']
    const queries = [
      'the urlInput keydown handler for Enter',
      'the exact code for the urlInput keydown handler when Enter is pressed',
      'the exact lines with exact whitespace for the urlInput keydown handler on Enter',
      'what does the urlInput keydown handler do when Enter is pressed',
      'the keydown handler for urlInput on Enter with exact whitespace',
      'the precise implementation of the urlInput keydown handler for Enter',
      'exact source for the urlInput keydown handler on Enter with correct indentation',
    ]

    const recentFingerprints: string[] = []
    const dupeFlags: boolean[] = []
    for (const query of queries) {
      const args = { query, paths }
      const normalized = normalizeExploreArgs('explore', args)
      dupeFlags.push(isDuplicateExploreCall('explore', args, recentFingerprints))
      recentFingerprints.push(toolCallFingerprint('explore', normalized))
    }

    // The first call establishes the baseline; every paraphrase after it is a
    // repeat of something already asked.
    assert.deepEqual(dupeFlags, [false, true, true, true, true, true, true])
  })

  it('does not flag two genuinely different explore queries against different paths', () => {
    const recentFingerprints: string[] = []
    const first = {
      query: 'how does the login form validate email addresses',
      paths: ['src/renderer/views/login-form.ts'],
    }
    const second = {
      query: 'explain the websocket reconnect backoff logic',
      paths: ['src/main/services/socket.ts'],
    }

    assert.equal(isDuplicateExploreCall('explore', first, recentFingerprints), false)
    recentFingerprints.push(toolCallFingerprint('explore', normalizeExploreArgs('explore', first)))
    assert.equal(isDuplicateExploreCall('explore', second, recentFingerprints), false)
  })

  it('does not flag two distinct-topic questions about the same file (review fix)', () => {
    // The common case a pure ratio threshold must not break: two unrelated
    // questions about the *same* file are legitimate, separate exploration,
    // not a repeat, even though they share `paths`.
    const paths = ['src/renderer/views/url-bar.ts']
    const recentFingerprints: string[] = []
    const first = { query: 'where is the keydown handler for the URL input', paths }
    const second = {
      query: 'how does the back button update navigation history',
      paths,
    }
    recentFingerprints.push(toolCallFingerprint('explore', normalizeExploreArgs('explore', first)))
    assert.equal(isDuplicateExploreCall('explore', second, recentFingerprints), false)
  })

  it('does not flag a short, low-overlap pair even at a 0.5 ratio (review fix)', () => {
    // "urlInput keydown handler" vs "urlInput blur handler" tokenize to
    // {urlinput, keydown, handler} and {urlinput, blur, handler}: 2 shared
    // of 4 unique tokens is exactly a 0.5 Jaccard ratio — at
    // EXPLORE_QUERY_JACCARD_DUPLICATE_THRESHOLD alone this would clear the
    // bar despite asking about two different event handlers.
    // MIN_SHARED_EXPLORE_QUERY_TOKENS (4) requires more *absolute* overlap
    // than these two short queries have (2), so it is not flagged — unlike
    // the #1433 paraphrases above, which all share >= 4 tokens.
    const paths = ['src/renderer/views/url-bar.ts']
    const recentFingerprints: string[] = []
    const first = { query: 'urlInput keydown handler', paths }
    const second = { query: 'urlInput blur handler', paths }
    recentFingerprints.push(toolCallFingerprint('explore', normalizeExploreArgs('explore', first)))
    assert.equal(isDuplicateExploreCall('explore', second, recentFingerprints), false)
  })

  it('does not flag overlapping wording when paths differ', () => {
    // Same core wording, but scoped to different files — a legitimate
    // "same question, different target" pair, not a repeat.
    const recentFingerprints: string[] = []
    const first = {
      query: 'the urlInput keydown handler implementation',
      paths: ['src/renderer/views/url-bar.ts'],
    }
    const second = {
      query: 'the urlInput keydown handler implementation',
      paths: ['src/renderer/views/search-bar.ts'],
    }
    recentFingerprints.push(toolCallFingerprint('explore', normalizeExploreArgs('explore', first)))
    assert.equal(isDuplicateExploreCall('explore', second, recentFingerprints), false)
  })
})

describe('nextConsecutiveExploreWithoutRead', () => {
  it('increments on explore, resets on read_file, and is untouched by other tools', () => {
    let streak = 0
    streak = nextConsecutiveExploreWithoutRead(streak, 'explore')
    assert.equal(streak, 1)
    streak = nextConsecutiveExploreWithoutRead(streak, 'explore')
    assert.equal(streak, 2)
    streak = nextConsecutiveExploreWithoutRead(streak, 'str_replace')
    assert.equal(streak, 2)
    streak = nextConsecutiveExploreWithoutRead(streak, 'explore')
    assert.equal(streak, EXPLORE_WITHOUT_READ_NUDGE_THRESHOLD)
    streak = nextConsecutiveExploreWithoutRead(streak, 'read_file')
    assert.equal(streak, 0)
    streak = nextConsecutiveExploreWithoutRead(streak, 'explore')
    assert.equal(streak, 1)
  })
})

describe('hasOpenTodos', () => {
  it('detects pending and in_progress', () => {
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'completed' }]), false)
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'pending' }]), true)
    assert.equal(hasOpenTodos([{ id: '1', content: 'x', status: 'in_progress' }]), true)
  })
})
