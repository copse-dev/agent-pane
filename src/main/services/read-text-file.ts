import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createInterface } from 'node:readline'

const SNIFF_BYTES = 8192

type TextEncoding = 'utf8' | 'utf16le' | 'utf16be'

export interface ReadTextLineRangeOptions {
  startLine: number
  endLine?: number | undefined
  maxLines: number
  maxChars: number
}

export interface ReadTextLineRangeResult {
  text: string
  startLine: number
  endLine: number
  totalLines: number
  lineTruncated: boolean
  charTruncated: boolean
}

function looksLikeUtf16Le(buf: Buffer): boolean {
  if (buf.length < 4) return false
  let zeroAtOdd = 0
  let pairs = 0
  const limit = Math.min(buf.length - 1, 512)
  for (let i = 1; i < limit; i += 2) {
    pairs++
    if (buf[i] === 0) zeroAtOdd++
  }
  return pairs >= 2 && zeroAtOdd / pairs >= 0.6
}

function looksLikeUtf16Be(buf: Buffer): boolean {
  if (buf.length < 4) return false
  let zeroAtEven = 0
  let pairs = 0
  const limit = Math.min(buf.length - 1, 512)
  for (let i = 0; i < limit; i += 2) {
    pairs++
    if (buf[i] === 0) zeroAtEven++
  }
  return pairs >= 2 && zeroAtEven / pairs >= 0.6
}

export function detectTextEncoding(buf: Buffer): { encoding: TextEncoding; bomSkip: number } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8', bomSkip: 3 }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', bomSkip: 2 }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf16be', bomSkip: 2 }
  }
  if (looksLikeUtf16Le(buf)) return { encoding: 'utf16le', bomSkip: 0 }
  if (looksLikeUtf16Be(buf)) return { encoding: 'utf16be', bomSkip: 0 }
  return { encoding: 'utf8', bomSkip: 0 }
}

export function isLikelyBinaryText(sample: Buffer, encoding: TextEncoding): boolean {
  if (encoding === 'utf16le' || encoding === 'utf16be') return false
  return sample.includes(0)
}

function normalizeLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

async function* iterateUtf16BeLines(absPath: string, bomSkip: number): AsyncGenerator<string> {
  const handle = await fs.open(absPath, 'r')
  const decoder = new TextDecoder('utf-16be')
  let carry = ''
  try {
    const buf = Buffer.alloc(64 * 1024)
    let offset = bomSkip
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      const chunk = carry + decoder.decode(buf.subarray(0, bytesRead), { stream: true })
      const parts = chunk.split('\n')
      carry = parts.pop() ?? ''
      for (const part of parts) yield normalizeLine(part)
    }
    if (carry.length > 0) yield normalizeLine(carry)
  } finally {
    await handle.close()
  }
}

async function* iterateStreamLines(
  absPath: string,
  encoding: 'utf8' | 'utf16le',
  bomSkip: number,
): AsyncGenerator<string> {
  const stream = createReadStream(absPath, { encoding, start: bomSkip })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    yield normalizeLine(line)
  }
}

async function* iterateLines(
  absPath: string,
  encoding: TextEncoding,
  bomSkip: number,
): AsyncGenerator<string> {
  if (encoding === 'utf16be') {
    yield* iterateUtf16BeLines(absPath, bomSkip)
    return
  }
  yield* iterateStreamLines(absPath, encoding, bomSkip)
}

function plannedEndInclusive(
  startIdx: number,
  endLine: number | undefined,
  maxLines: number,
): number {
  const maxEndByBudget = startIdx + maxLines
  const requestedEnd = endLine ?? maxEndByBudget
  return Math.min(Math.max(startIdx + 1, requestedEnd), maxEndByBudget)
}

function sliceEndInclusive(
  totalLines: number,
  startIdx: number,
  endLine: number | undefined,
  maxLines: number,
): number {
  return Math.min(totalLines, plannedEndInclusive(startIdx, endLine, maxLines))
}

export async function readTextLineRange(
  absPath: string,
  opts: ReadTextLineRangeOptions,
): Promise<ReadTextLineRangeResult> {
  const handle = await fs.open(absPath, 'r')
  let sample: Buffer
  try {
    const buf = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0)
    sample = buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }

  const { encoding, bomSkip } = detectTextEncoding(sample)
  if (isLikelyBinaryText(sample, encoding)) {
    return {
      text: '[Binary file — cannot display as text]',
      startLine: opts.startLine,
      endLine: 0,
      totalLines: 0,
      lineTruncated: false,
      charTruncated: false,
    }
  }

  const startLine = opts.startLine
  const startIdx = startLine - 1
  const selected: string[] = []
  let lineNumber = 0
  let charTruncated = false
  const endInclusive = plannedEndInclusive(startIdx, opts.endLine, opts.maxLines)

  for await (const line of iterateLines(absPath, encoding, bomSkip)) {
    lineNumber++
    if (lineNumber <= startIdx) continue
    if (lineNumber > endInclusive) continue
    if (charTruncated) continue

    selected.push(line)
    const joined = selected.join('\n')
    if (joined.length > opts.maxChars) {
      const over = joined.length - opts.maxChars
      selected.pop() // remove the `line` just pushed above; re-add a trimmed copy below
      const trimmedLast = line.slice(0, Math.max(0, line.length - over))
      if (trimmedLast.length > 0) selected.push(trimmedLast)
      charTruncated = true
    }
  }

  const totalLines = lineNumber
  const endLine = selected.length > 0 ? startLine + selected.length - 1 : Math.max(0, startLine - 1)
  const lineTruncated =
    sliceEndInclusive(totalLines, startIdx, opts.endLine, opts.maxLines) < totalLines

  return {
    text: selected.join('\n'),
    startLine,
    endLine,
    totalLines,
    lineTruncated,
    charTruncated,
  }
}

/** Line-range read from an already-loaded UTF-8 string (remote WorkspaceFs reads). */
export function readTextLineRangeFromUtf8Content(
  content: string,
  opts: ReadTextLineRangeOptions,
): ReadTextLineRangeResult {
  const sample = Buffer.from(content.slice(0, SNIFF_BYTES), 'utf-8')
  const { encoding, bomSkip } = detectTextEncoding(sample)
  if (isLikelyBinaryText(sample, encoding)) {
    return {
      text: '[Binary file — cannot display as text]',
      startLine: opts.startLine,
      endLine: 0,
      totalLines: 0,
      lineTruncated: false,
      charTruncated: false,
    }
  }
  void bomSkip
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()

  const startLine = opts.startLine
  const startIdx = startLine - 1
  const selected: string[] = []
  let charTruncated = false
  const endInclusive = plannedEndInclusive(startIdx, opts.endLine, opts.maxLines)

  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber++) {
    if (lineNumber <= startIdx) continue
    if (lineNumber > endInclusive) continue
    if (charTruncated) continue
    const line = lines[lineNumber - 1] ?? ''
    selected.push(line)
    const joined = selected.join('\n')
    if (joined.length > opts.maxChars) {
      const over = joined.length - opts.maxChars
      selected.pop()
      const trimmedLast = line.slice(0, Math.max(0, line.length - over))
      if (trimmedLast.length > 0) selected.push(trimmedLast)
      charTruncated = true
    }
  }

  const totalLines = lines.length
  const endLine = selected.length > 0 ? startLine + selected.length - 1 : Math.max(0, startLine - 1)
  const lineTruncated =
    sliceEndInclusive(totalLines, startIdx, opts.endLine, opts.maxLines) < totalLines

  return {
    text: selected.join('\n'),
    startLine,
    endLine,
    totalLines,
    lineTruncated,
    charTruncated,
  }
}
