import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  completeEndsInOpenTable,
  getIncompleteFenceSource,
  isAmbiguousBlockLine,
  pendingLineBelongsInTable,
  scanLines,
  streamingHoldStart,
  tokenizeBlocks,
} from './block-tokenizer.ts'
import { splitForStreaming } from './streaming-split.ts'

describe('scanLines', () => {
  it('marks the final line unterminated when source lacks a trailing newline', () => {
    const lines = scanLines('a\nb')
    assert.equal(lines.length, 2)
    const first = lines[0]
    const second = lines[1]
    assert.ok(first && second)
    assert.equal(first.terminated, true)
    assert.equal(second.terminated, false)
  })
})

describe('tokenizeBlocks', () => {
  it('marks an ATX heading line without newline as ambiguous', () => {
    const blocks = tokenizeBlocks('## Title')
    assert.deepEqual(blocks, [{ kind: 'atx_heading', status: 'ambiguous', start: 0, end: 8 }])
  })

  it('marks a completed ATX heading once the line ends', () => {
    const blocks = tokenizeBlocks('## Title\n')
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'atx_heading')
    assert.equal(block.status, 'complete')
  })

  it('marks an open fenced code block', () => {
    const source = '```ts\nconst x = 1'
    const blocks = tokenizeBlocks(source)
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'fence')
    assert.equal(block.status, 'open')
    assert.equal(block.start, 0)
  })

  it('marks a complete fenced code block', () => {
    const source = '```ts\nconst x = 1\n```\n'
    const blocks = tokenizeBlocks(source)
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'fence')
    assert.equal(block.status, 'complete')
  })

  it('marks an open table when the last row has no trailing newline', () => {
    const source = '| A | B |\n| - | - |\n| one'
    const blocks = tokenizeBlocks(source)
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'table')
    assert.equal(block.status, 'open')
  })

  it('marks a lone final text line as an open paragraph (setext waits for next line)', () => {
    const blocks = tokenizeBlocks('Heading')
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'paragraph')
    assert.equal(block.status, 'open')
  })

  it('ends an unordered list item when blank is followed by under-indented text (#255)', () => {
    const blocks = tokenizeBlocks('- one\n\n two\n')
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['list_item', 'blank', 'paragraph'],
    )
  })

  it('continues an unordered list item when blank is followed by indented text (#256)', () => {
    const blocks = tokenizeBlocks('- one\n\n  two\n')
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['list_item'],
    )
  })

  it('treats a 10-digit ordered marker as a paragraph (#266)', () => {
    const blocks = tokenizeBlocks('1234567890. not ok\n')
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['paragraph'],
    )
  })
})

describe('streamingHoldStart', () => {
  it('holds from the first non-complete block', () => {
    const source = 'done\n## Title'
    const blocks = tokenizeBlocks(source)
    assert.equal(streamingHoldStart(blocks), 'done\n'.length)
  })
})

describe('isAmbiguousBlockLine', () => {
  it('detects block-start patterns on the pending line', () => {
    assert.equal(isAmbiguousBlockLine('- item'), true)
    assert.equal(isAmbiguousBlockLine('plain text'), false)
  })

  it('does not treat RFC-style metadata lines as ambiguous table rows', () => {
    const metadata =
      '**Status:** Proposed &nbsp;&nbsp;|&nbsp;&nbsp; **Authors:** Engineering Guild &nbsp;&nbsp;|&nbsp;&nbsp; **Created:** 2025-01-25'
    assert.equal(isAmbiguousBlockLine(metadata), false)
    assert.equal(isAmbiguousBlockLine('| A | B |'), true)
  })

  it('does not tokenize consecutive JD metadata lines as a table', () => {
    const md = [
      '# Job',
      '',
      '**Department:** Engineering &nbsp;&nbsp;|&nbsp;&nbsp; **Reports To:** VP',
      '**Employment Type:** Full-Time &nbsp;&nbsp;|&nbsp;&nbsp; **Salary Range:** $160k',
      '',
    ].join('\n')
    const kinds = tokenizeBlocks(md).map((b) => b.kind)
    assert.ok(!kinds.includes('table'))
  })
})

describe('table streaming helpers', () => {
  it('detects an open table tail', () => {
    const complete = '| A | B |\n| - | - |\n| one |\n'
    assert.equal(completeEndsInOpenTable(complete), true)
    assert.equal(pendingLineBelongsInTable(complete, '| two | cells |'), true)
  })
})

describe('splitForStreaming (tokenizer #475)', () => {
  it('holds an ambiguous ATX heading until its line ends', () => {
    assert.deepEqual(splitForStreaming('## Title'), {
      complete: '',
      pending: '## Title',
    })
  })

  it('holds a table header row until the separator confirms structure', () => {
    assert.deepEqual(splitForStreaming('| A | B |'), {
      complete: '',
      pending: '| A | B |',
    })
    assert.deepEqual(splitForStreaming('| A | B |\n| - |'), {
      complete: '',
      pending: '| A | B |\n| - |',
    })
  })

  it('commits a table once header and separator lines are complete', () => {
    assert.deepEqual(splitForStreaming('| A | B |\n| - | - |\n'), {
      complete: '| A | B |\n| - | - |\n',
      pending: '',
    })
  })

  it('holds an open fence from its opener', () => {
    assert.deepEqual(splitForStreaming('intro\n```ts\ncode'), {
      complete: 'intro\n',
      pending: '```ts\ncode',
    })
  })

  it('returns incomplete fence source while the closing fence is missing', () => {
    const source = 'intro\n```yaml\nstatic_resources:\n'
    assert.equal(getIncompleteFenceSource(source), '```yaml\nstatic_resources:\n')
  })

  it('holds unresolved inline emphasis inside an open paragraph', () => {
    assert.deepEqual(splitForStreaming('intro **bold\ntext'), {
      complete: 'intro ',
      pending: '**bold\ntext',
    })
  })

  it('falls back to line split for safe plain text', () => {
    assert.deepEqual(splitForStreaming('done\nplain tail'), {
      complete: 'done\n',
      pending: 'plain tail',
    })
  })

  it('commits finished list items while the next item is still streaming', () => {
    assert.deepEqual(splitForStreaming('- item one\n- item two'), {
      complete: '- item one\n',
      pending: '- item two',
      openListItemFirstLine: '- item two',
    })
  })

  it('commits finished table body rows while the next row is still streaming', () => {
    assert.deepEqual(
      splitForStreaming(
        '| Path | Role |\n| - | - |\n| src/ | Application source |\n| tests/e2e/ | WebdriverIO specs |',
      ),
      {
        complete: '| Path | Role |\n| - | - |\n| src/ | Application source |\n',
        pending: '| tests/e2e/ | WebdriverIO specs |',
      },
    )
  })
})
