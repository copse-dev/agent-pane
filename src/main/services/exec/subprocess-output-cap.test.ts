import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CappedOutputAccumulator,
  COMMAND_OUTPUT_TRUNCATED_MARKER,
  evidenceRank,
  stripTerminalControlSequences,
  truncateCommandOutput,
  truncateToolOutput,
} from './subprocess-output-cap.ts'

describe('stripTerminalControlSequences', () => {
  it('removes SGR and clears screen sequences', () => {
    assert.equal(stripTerminalControlSequences('\x1b[31mred\x1b[0m'), 'red')
    assert.equal(stripTerminalControlSequences('ok\x1b[2Jmore'), 'okmore')
  })

  it('preserves literal bracket text without ESC', () => {
    assert.equal(stripTerminalControlSequences('[not-ansi]'), '[not-ansi]')
  })
})

describe('truncateCommandOutput', () => {
  it('returns input when under the cap', () => {
    assert.equal(truncateCommandOutput('hello', 100), 'hello')
  })

  it('keeps head and tail with a marker', () => {
    const out = truncateCommandOutput('a'.repeat(100), 40)
    assert.ok(out.includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
    assert.ok(out.startsWith('aaa'))
    assert.ok(out.endsWith('aaa'))
  })
})

describe('CappedOutputAccumulator', () => {
  it('streams and stores within the cap without dropping when small', () => {
    const acc = new CappedOutputAccumulator(200)
    assert.equal(acc.append('hello '), 'hello ')
    assert.equal(acc.append('world'), 'world')
    assert.equal(acc.toString(), 'hello world')
  })

  it('emits a truncation marker once output exceeds the cap', () => {
    const acc = new CappedOutputAccumulator(40)
    acc.append('a'.repeat(30))
    acc.append('b'.repeat(30))
    assert.ok(acc.toString().includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
  })
})

const CAP = 100 * 1024

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Deterministic noise lines that match no evidence pattern. */
function noise(lineCount: number, prefix = 'progress'): string {
  let out = ''
  for (let i = 0; i < lineCount; i++)
    out += `${prefix} step ${String(i)} ok, crème brûlée 中文 🙂\n`
  return out
}

/** Split `text` into pseudo-random chunks without splitting a surrogate pair. */
function chunks(text: string, seed: number, maxChunk: number): string[] {
  let state = seed
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state
  }
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + 1 + (next() % maxChunk))
    const prev = text.charCodeAt(end - 1)
    if (end < text.length && prev >= 0xd800 && prev <= 0xdbff) end++
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

function accumulate(parts: readonly string[], maxBytes: number, evidence = true): string {
  const acc = new CappedOutputAccumulator(maxBytes, { evidence })
  for (const part of parts) acc.append(part)
  return acc.toString()
}

const MIDDLE_EVIDENCE = [
  "src/app/main.ts:42:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
  'warning: unused variable `count`',
  '    at Object.<anonymous> (/repo/test/thing.test.js:10:15)',
  'Traceback (most recent call last):',
  '  File "/repo/tool.py", line 12, in <module>',
  'ValueError: bad input',
  'thread main panicked at src/lib.rs:7:5',
]

function withMiddleEvidence(): string {
  return noise(3000, 'head') + MIDDLE_EVIDENCE.join('\n') + '\n' + noise(3000, 'tail')
}

describe('CappedOutputAccumulator evidence-preserving truncation', () => {
  it('keeps output up to the cap verbatim, with no marker', () => {
    // Regression: output between half the cap and the cap used to gain a
    // marker although nothing was dropped.
    const text = noise(1500).slice(0, 90 * 1024)
    assert.equal(accumulate(chunks(text, 1, 4000), CAP), text)
    const exact = 'x'.repeat(CAP)
    assert.equal(accumulate([exact], CAP), exact)
    assert.equal(truncateToolOutput(exact, CAP, { evidence: true }), exact)
  })

  it('keeps error, warning, location, and stack-frame lines from the dropped middle', () => {
    const text = withMiddleEvidence()
    assert.ok(bytes(text) > 2 * CAP)
    const out = truncateToolOutput(text, CAP, { evidence: true })

    assert.ok(out.includes(COMMAND_OUTPUT_TRUNCATED_MARKER), 'legacy marker stays a prefix')
    for (const line of MIDDLE_EVIDENCE) assert.ok(out.includes(`\n${line}\n`), line)
    assert.ok(out.startsWith('head step 0 ok'))
    assert.ok(out.endsWith('tail step 2999 ok, crème brûlée 中文 🙂\n'))
    assert.match(
      out,
      /\[dropped \d+ bytes \(~\d+ lines\) from the middle; 7 error\/warning\/location lines from that span kept below\.\]\n/,
    )
    assert.ok(out.includes('[end of kept lines]\n'))
    assert.ok(bytes(out) <= CAP)
  })

  it('reports exactly how many bytes were dropped', () => {
    const text = noise(6000)
    const out = truncateToolOutput(text, CAP, { evidence: true })
    const match = /\[dropped (\d+) bytes/.exec(out)
    assert.ok(match?.[1])
    const marker = out.indexOf(COMMAND_OUTPUT_TRUNCATED_MARKER)
    const head = out.slice(0, marker)
    const tail = out.slice(out.indexOf('.]\n', marker) + 3)
    assert.ok(text.startsWith(head) && text.endsWith(tail))
    assert.equal(Number(match[1]), bytes(text) - bytes(head) - bytes(tail))
  })

  it('produces the same result however the stream is chunked', () => {
    const text = withMiddleEvidence() + noise(500, 'more') + 'error: final failure\n'
    const expected = truncateToolOutput(text, CAP, { evidence: true })
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const maxChunk of [7, 300, 65_536]) {
        assert.equal(
          accumulate(chunks(text, seed, maxChunk), CAP),
          expected,
          `${String(seed)}/${String(maxChunk)}`,
        )
      }
    }
  })

  it('is deterministic across chunkings that split multibyte characters at the head and tail edges', () => {
    const text = noise(400)
    const expected = accumulate([text], 4096)
    assert.equal(accumulate(chunks(text, 9, 1), 4096), expected)
    assert.equal(accumulate(chunks(text, 10, 3), 4096), expected)
    assert.ok(!expected.includes('�'), 'no code point is cut in half')
  })

  it('never exceeds the cap, even when every line is evidence', () => {
    const flood = Array.from(
      { length: 20_000 },
      (_, i) => `src/f${String(i)}.ts:${String(i)}:1 error: bad ${'é'.repeat(i % 40)}`,
    ).join('\n')
    for (const cap of [2048, 4096, 50 * 1024, CAP]) {
      for (const maxChunk of [500, 70_000]) {
        const out = accumulate(chunks(flood, cap, maxChunk), cap)
        assert.ok(bytes(out) <= cap, `${String(cap)}: ${String(bytes(out))}`)
      }
    }
  })

  it('prefers failures over warnings and locations when the evidence budget is full', () => {
    const text =
      noise(1500, 'head') +
      Array.from({ length: 3000 }, (_, i) => `warning: deprecated api ${String(i)}`).join('\n') +
      '\nFAILED tests/core.test.ts > parses input\n' +
      noise(1500, 'tail')
    const out = truncateToolOutput(text, CAP, { evidence: true })
    assert.ok(out.includes('\nFAILED tests/core.test.ts > parses input\n'))
    assert.ok(
      out.includes('warning: deprecated api 0\n'),
      'earliest warnings fill the remaining budget',
    )
    assert.ok(!out.includes('warning: deprecated api 2999\n'))
    assert.ok(bytes(out) <= CAP)
  })

  it('ignores clean tallies and matches through ANSI colour', () => {
    const text =
      noise(1500, 'head') +
      'Found 0 errors and no warnings.\n' +
      '\x1b[31merror\x1b[0m: could not compile `app`\n' +
      noise(1500, 'tail')
    const out = truncateToolOutput(text, CAP, { evidence: true })
    assert.ok(!out.includes('Found 0 errors'))
    assert.ok(out.includes('\x1b[31merror\x1b[0m: could not compile `app`\n'))
  })

  it('bounds a single enormous line and elides it in the evidence', () => {
    const text =
      noise(1500, 'head') + 'error: ' + 'z'.repeat(5 * 1024 * 1024) + '\n' + noise(1500, 'tail')
    const out = truncateToolOutput(text, CAP, { evidence: true })
    assert.ok(bytes(out) <= CAP)
    const kept = /\n(error: z+)…\n\[end of kept lines\]\n/.exec(out)
    assert.ok(kept?.[1], 'the long line is kept, elided')
    assert.ok(bytes(kept[1]) <= 512)
  })

  it('keeps no evidence lines when evidence is off', () => {
    const out = truncateToolOutput(withMiddleEvidence(), CAP)
    assert.match(out, /\[dropped \d+ bytes \(~\d+ lines\) from the middle\.\]\n/)
    assert.ok(!out.includes('ValueError: bad input'))
    assert.ok(!out.includes('[end of kept lines]'))
  })

  it('appends a caller hint to the summary', () => {
    const acc = new CappedOutputAccumulator(4096, { hint: 'Narrow the command.' })
    acc.append(noise(400))
    assert.match(acc.toString(), /from the middle\. Narrow the command\.\]\n/)
  })

  it('falls back to the bare marker for tiny caps', () => {
    const acc = new CappedOutputAccumulator(200, { evidence: true })
    acc.append('error: '.repeat(100))
    const out = acc.toString()
    assert.ok(out.includes(COMMAND_OUTPUT_TRUNCATED_MARKER))
    assert.ok(!out.includes('[dropped'))
    assert.ok(bytes(out) <= 200)
  })

  it('lets toString be called mid-stream without changing the final result', () => {
    const parts = chunks(withMiddleEvidence(), 4, 9000)
    const acc = new CappedOutputAccumulator(CAP, { evidence: true })
    for (const part of parts) {
      acc.append(part)
      acc.toString()
    }
    assert.equal(acc.toString(), accumulate(parts, CAP))
  })
})

describe('evidenceRank', () => {
  it('ranks failures, then warnings, then locations', () => {
    assert.equal(evidenceRank('npm ERR! code ELIFECYCLE'), 0)
    assert.equal(evidenceRank('TypeError: x is not a function'), 0)
    assert.equal(evidenceRank('not ok 3 - handles empty input'), 0)
    assert.equal(evidenceRank('WARN deprecated package'), 1)
    assert.equal(evidenceRank('  --> src/main.rs:4:9'), 2)
    assert.equal(evidenceRank('    at run (node:internal/x:1:2)'), 2)
    assert.equal(evidenceRank('compiled 12 files'), null)
    assert.equal(evidenceRank('0 failed, 12 passed'), null)
    assert.equal(evidenceRank('   '), null)
  })
})
