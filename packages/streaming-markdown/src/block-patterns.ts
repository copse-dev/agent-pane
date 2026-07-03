/** Shared block-level line patterns and fence helpers (tokenizer + renderer). */

/** Width of a line's leading whitespace in columns, expanding tabs to 4-col stops. */
export function leadingIndentWidth(line: string): number {
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') col++
    else if (ch === '\t') col += 4 - (col % 4)
    else break
  }
  return col
}

/**
 * Remove up to four columns of leading indentation, expanding tabs to 4-col
 * stops. A tab that straddles the fourth column leaves its remainder as spaces
 * (CommonMark tab handling for indented code).
 */
export function stripFourColumnIndent(line: string): string {
  let col = 0
  let i = 0
  while (i < line.length && col < 4) {
    const ch = line[i]
    if (ch === ' ') {
      col++
      i++
      continue
    }
    if (ch === '\t') {
      const advance = 4 - (col % 4)
      if (col + advance > 4) return ' '.repeat(col + advance - 4) + line.slice(i + 1)
      col += advance
      i++
      continue
    }
    break
  }
  return line.slice(i)
}

export const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n`]*)\s*$/
export const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/

/** ATX heading detection (tokenizer): `#` through `######` followed by space, tab, or EOL. */
export const ATX_HEADING_DETECT_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/

/** ATX heading capture (renderer): optional title after `#` markers (space or tab separator). */
export const ATX_HEADING_CAPTURE_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/

/** Blockquote line detection (CommonMark: up to 3 spaces, `>`, optional space). */
export const BLOCKQUOTE_DETECT_RE = /^ {0,3}> ?/

/** Strip one blockquote marker level from a line. */
export function stripBlockquoteMarker(line: string): string {
  return line.replace(BLOCKQUOTE_DETECT_RE, '')
}

/** Drop the block-terminating newline token slices include. */
export function dropTrailingNewline(slice: string): string {
  return slice.endsWith('\n') ? slice.slice(0, -1) : slice
}

/** Strip optional ATX closing hash run (` ##` at end of heading text). */
export function stripAtxClosingHashes(title: string): string {
  // A title that is nothing but hashes ("### ###") is a bare closing sequence.
  if (/^#+\s*$/.test(title)) return ''
  return title.replace(/(?<!\\)\s+#+\s*$/, '').trimEnd()
}

export function fenceMarker(line: string): { marker: string; len: number; info: string } | null {
  const m = line.match(FENCE_OPEN_RE)
  if (!m?.[1]) return null
  const marker = m[1]
  return { marker, len: marker.length, info: (m[2] ?? '').trim() }
}

export function fenceCloses(marker: string, len: number, line: string): boolean {
  const m = line.match(FENCE_CLOSE_RE)
  if (!m?.[1] || m[1][0] !== marker[0]) return false
  return m[1].length >= len
}

export function parseFenceSlice(slice: string): { lang: string; code: string } {
  const lines = dropTrailingNewline(slice).split('\n')
  const open = lines[0] ?? ''
  const openMatch = open.match(FENCE_OPEN_RE)
  const marker = openMatch?.[1] ?? '```'
  const lang = (openMatch?.[2] ?? '').trim()
  let closeIndex = lines.length - 1
  while (closeIndex > 0) {
    const line = lines[closeIndex] ?? ''
    if (fenceCloses(marker, marker.length, line)) {
      break
    }
    closeIndex--
  }
  const code = lines.slice(1, closeIndex).join('\n')
  return { lang, code }
}

/** Parse an open (still streaming) fenced block — body includes all lines after the opener. */
export function parseOpenFenceContent(source: string): { lang: string; code: string } | null {
  const lines = source.split('\n')
  const open = lines[0] ?? ''
  const openMatch = open.match(FENCE_OPEN_RE)
  if (!openMatch?.[1]) return null
  const lang = (openMatch[2] ?? '').trim()
  let bodyLines = lines.slice(1)
  const last = bodyLines.at(-1) ?? ''
  if (bodyLines.length > 0 && fenceCloses(openMatch[1], openMatch[1].length, last)) {
    bodyLines = bodyLines.slice(0, -1)
  }
  return { lang, code: bodyLines.join('\n') }
}
