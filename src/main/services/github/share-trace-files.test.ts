import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Thread } from '@shared/types'
import {
  buildShareTracePackage,
  SHARE_TRACE_DIR,
  shareTraceTotalBytes,
} from './share-trace-files.ts'

function sampleThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-abc123def456',
    title: 'Fix the footer overflow / share!',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'm1',
        role: 'user',
        createdAt: 1,
        content: 'hello',
        toolCalls: [],
      },
    ],
    usage: { inputTokens: 1, outputTokens: 2 },
    ...overrides,
  }
}

describe('buildShareTracePackage', () => {
  it('builds branch, folder, portable JSONL, and optional store files', () => {
    const now = new Date('2026-07-22T15:04:05.000Z')
    const pkg = buildShareTracePackage(
      sampleThread({ model: 'claude-sonnet-4' }),
      {
        eventsJsonl: '{"type":"message"}\n',
        metaJson: '{"id":"thread-abc123def456"}\n',
      },
      now,
    )

    assert.equal(pkg.folder, '2026-07-22-threadabc123')
    assert.equal(pkg.branch, 'debug/trace-threadabc123-20260722-150405')
    assert.match(pkg.title, /debug: share trace threadabc123/)
    assert.deepEqual(
      pkg.files.map((f) => f.path),
      [
        `${SHARE_TRACE_DIR}/2026-07-22-threadabc123/thread.jsonl`,
        `${SHARE_TRACE_DIR}/2026-07-22-threadabc123/events.jsonl`,
        `${SHARE_TRACE_DIR}/2026-07-22-threadabc123/meta.json`,
      ],
    )
    assert.match(pkg.files[0]?.content ?? '', /"type":"thread"/)
    assert.equal(pkg.files[1]?.content, '{"type":"message"}\n')
    assert.match(pkg.body, /npm run analyze:thread/)
    assert.match(pkg.body, /Treat as private|treat as private/i)
  })

  it('omits missing store attachments', () => {
    const pkg = buildShareTracePackage(sampleThread(), {}, new Date('2026-07-22T00:00:00.000Z'))
    assert.equal(pkg.files.length, 1)
    assert.ok(pkg.files[0]?.path.endsWith('/thread.jsonl'))
  })

  it('sums UTF-8 byte lengths', () => {
    assert.equal(
      shareTraceTotalBytes([
        { path: 'a', content: 'hi' },
        { path: 'b', content: '🙂' },
      ]),
      2 + Buffer.byteLength('🙂', 'utf8'),
    )
  })
})
