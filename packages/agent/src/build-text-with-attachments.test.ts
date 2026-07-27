import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTextWithAttachments,
  isTextBlockAttachment,
  textBlockLabel,
  truncateAttachmentContent,
  TEXT_BLOCK_MIN_CHARS,
  TEXT_BLOCK_MIN_LINES,
  ATTACHMENT_MAX_CHARS,
} from './build-text-with-attachments.ts'

describe('isTextBlockAttachment', () => {
  it('rejects empty or whitespace-only text', () => {
    assert.equal(isTextBlockAttachment(''), false)
    assert.equal(isTextBlockAttachment('   \n  '), false)
  })

  it('keeps short multiline pastes inline (a few lines is not an attachment)', () => {
    assert.equal(isTextBlockAttachment('line one\nline two'), false)
    assert.equal(isTextBlockAttachment('The editor points:\n\n- tighten intro\n- fix typos'), false)
  })

  it(`accepts pastes of ${String(TEXT_BLOCK_MIN_LINES)}+ lines regardless of char length`, () => {
    const lines = Array.from({ length: TEXT_BLOCK_MIN_LINES }, (_, i) => `l${String(i)}`)
    assert.ok(lines.join('\n').length < TEXT_BLOCK_MIN_CHARS)
    assert.equal(isTextBlockAttachment(lines.join('\n')), true)
    assert.equal(isTextBlockAttachment(lines.slice(0, -1).join('\n')), false)
  })

  it(`accepts long single-line text (>= ${String(TEXT_BLOCK_MIN_CHARS)} chars)`, () => {
    assert.equal(isTextBlockAttachment('a'.repeat(TEXT_BLOCK_MIN_CHARS)), true)
  })

  it('rejects short single-line text', () => {
    assert.equal(isTextBlockAttachment('short prompt'), false)
  })
})

describe('textBlockLabel', () => {
  it('uses the first line as the label', () => {
    assert.equal(textBlockLabel('function foo() {\n  return 1\n}'), 'function foo() {')
  })

  it('skips leading blank lines so the chip preview is never empty', () => {
    assert.equal(textBlockLabel('\n\n  \nEditor feedback\nmore detail'), 'Editor feedback')
  })

  it('falls back to a placeholder for whitespace-only content', () => {
    assert.equal(textBlockLabel('\n   \n'), 'Pasted text')
  })

  it('truncates long first lines', () => {
    const long = 'x'.repeat(60)
    assert.equal(textBlockLabel(long), `${'x'.repeat(45)}…`)
  })
})

describe('buildTextWithAttachments', () => {
  it('inlines file and text-block attachments into fenced code blocks', () => {
    const result = buildTextWithAttachments(
      'Please review',
      [{ path: 'src/a.ts', content: 'export const a = 1' }],
      [{ label: 'Error log', content: 'TypeError: x is not defined' }],
    )
    assert.match(result, /^Please review/)
    assert.match(result, /```\n\/\/ src\/a\.ts\nexport const a = 1\n```/)
    assert.match(result, /```\n\/\/ Error log\nTypeError: x is not defined\n```/)
  })

  it('caps oversized attachment content so a single paste cannot overflow context', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${String(i)}`).join('\n')
    assert.ok(huge.length > ATTACHMENT_MAX_CHARS)
    const result = buildTextWithAttachments('review', [{ path: 'big.log', content: huge }])
    assert.ok(result.length < huge.length)
    assert.match(result, /Copse trimmed/)
    // Head and tail are preserved for context at both ends.
    assert.match(result, /line 0\b/)
    assert.match(result, /line 4999\b/)
  })

  it('emits one steering preamble + a line per thread ref, inlining nothing', () => {
    const result = buildTextWithAttachments('compare these', [], [], {
      threadRefs: [
        { title: 'Auth refactor', date: '3d ago', spinePath: '/chat/proj/t1/events.jsonl' },
        { title: 'Docs update', date: '2026-06-30', spinePath: '/chat/proj/t2/events.jsonl' },
      ],
    })
    assert.match(result, /^compare these/)
    // Exactly one preamble regardless of how many threads are attached.
    assert.equal(result.match(/read-only through your file tools/g)?.length, 1)
    assert.match(result, /- "Auth refactor" \(3d ago\): \/chat\/proj\/t1\/events\.jsonl/)
    assert.match(result, /- "Docs update" \(2026-06-30\): \/chat\/proj\/t2\/events\.jsonl/)
    // Nothing inlined → no fenced code blocks from thread refs.
    assert.doesNotMatch(result, /```/)
  })

  it('adds no thread block when there are no thread refs', () => {
    const result = buildTextWithAttachments('hi', [], [], { threadRefs: [] })
    assert.equal(result, 'hi')
  })
})

describe('video refs', () => {
  const videoRefs = [
    { name: 'Screen Recording.mov', size: '12.4 MB', path: '/chat/proj/t1/blobs/media/a-rec.mov' },
    { name: 'bug.mp4', size: '900 KB', path: '/chat/proj/t1/blobs/media/b-bug.mp4' },
  ]

  it('emits one steering preamble + a line per video, inlining nothing', () => {
    const result = buildTextWithAttachments('what goes wrong here?', [], [], { videoRefs })
    assert.match(result, /^what goes wrong here\?/)
    assert.equal(result.match(/video_frames/g)?.length, 1)
    assert.match(
      result,
      /- "Screen Recording\.mov" \(12\.4 MB\): \/chat\/proj\/t1\/blobs\/media\/a-rec\.mov/,
    )
    assert.match(result, /- "bug\.mp4" \(900 KB\): \/chat\/proj\/t1\/blobs\/media\/b-bug\.mp4/)
    assert.doesNotMatch(result, /```/)
  })

  it('says plainly that the video itself is not in context', () => {
    // Without this the model reasonably assumes an attachment it can see, and
    // burns a turn asking the user why it cannot watch the recording.
    const result = buildTextWithAttachments('', [], [], { videoRefs })
    assert.match(result, /NOT in your context/)
    assert.match(result, /no audio track/i)
  })

  it('adds no video block when there are no videos', () => {
    assert.equal(buildTextWithAttachments('hi', [], [], { videoRefs: [] }), 'hi')
  })

  it('keeps thread refs and video refs as separate blocks', () => {
    const result = buildTextWithAttachments('both', [], [], {
      threadRefs: [{ title: 'T', date: 'now', spinePath: '/chat/p/t/events.jsonl' }],
      videoRefs,
    })
    assert.match(result, /Referenced threads:/)
    assert.match(result, /Attached videos:/)
  })
})

describe('truncateAttachmentContent', () => {
  it('returns content unchanged when it fits the cap', () => {
    const small = 'hello\nworld'
    assert.equal(truncateAttachmentContent(small, 100), small)
    assert.equal(truncateAttachmentContent('a'.repeat(100), 100), 'a'.repeat(100))
  })

  it('keeps head and tail and records what was dropped when over the cap', () => {
    const content = Array.from({ length: 200 }, (_, i) => `row ${String(i)}`).join('\n')
    const out = truncateAttachmentContent(content, 400)
    assert.ok(out.length <= content.length)
    assert.match(out, /^row 0\b/)
    assert.match(out, /row 199$/)
    assert.match(out, /Copse trimmed \d[\d,]* characters \(~\d[\d,]* lines\)/)
  })

  it('cuts on line boundaries (no split partial lines around the marker)', () => {
    const content = Array.from({ length: 100 }, (_, i) => `value-${String(i)}`).join('\n')
    const out = truncateAttachmentContent(content, 300)
    const [beforeMarker, afterMarker] = out.split(/\n\n… \[Copse trimmed[^\n]*\] …\n\n/)
    assert.ok(beforeMarker && afterMarker)
    // Every retained line is a complete `value-N` token, never a fragment.
    for (const line of `${beforeMarker}\n${afterMarker}`.split('\n')) {
      if (line) assert.match(line, /^value-\d+$/)
    }
  })
})
