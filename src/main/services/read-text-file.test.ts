import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  detectTextEncoding,
  isLikelyBinaryText,
  readTextLineRange,
  readTextLineRangeFromUtf8Content,
} from './read-text-file.ts'

describe('read-text-file', () => {
  it('detects UTF-8 BOM and strips content', () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hello', 'utf8')])
    const enc = detectTextEncoding(buf)
    assert.equal(enc.encoding, 'utf8')
    assert.equal(enc.bomSkip, 3)
  })

  it('does not treat UTF-16 LE as binary', () => {
    const buf = Buffer.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])
    const enc = detectTextEncoding(buf)
    assert.equal(enc.encoding, 'utf16le')
    assert.equal(isLikelyBinaryText(buf, enc.encoding), false)
  })

  it('strips CRLF line endings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-read-'))
    const file = join(dir, 'crlf.txt')
    await writeFile(file, 'a\r\nb\r\n', 'utf8')
    try {
      const result = await readTextLineRange(file, {
        startLine: 1,
        maxLines: 10,
        maxChars: 100,
      })
      assert.equal(result.text, 'a\nb')
      assert.equal(result.totalLines, 2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a line range without including unrelated tail lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-read-'))
    const file = join(dir, 'many.txt')
    const lines = [
      'first',
      ...Array.from({ length: 200 }, (_, i) => `line-${String(i)}`),
      'LAST-UNIQUE',
    ]
    await writeFile(file, lines.join('\n'), 'utf8')
    try {
      const result = await readTextLineRange(file, {
        startLine: 202,
        endLine: 202,
        maxLines: 150,
        maxChars: 10_000,
      })
      assert.equal(result.text, 'LAST-UNIQUE')
      assert.equal(result.totalLines, 202)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('readTextLineRangeFromUtf8Content strips UTF-8 BOM and CRLF like readTextLineRange', () => {
    const result = readTextLineRangeFromUtf8Content('\ufeffline1\r\nline2\r\n', {
      startLine: 1,
      maxLines: 10,
      maxChars: 100,
    })
    assert.equal(result.text, 'line1\nline2')
    assert.equal(result.totalLines, 2)
  })
})
