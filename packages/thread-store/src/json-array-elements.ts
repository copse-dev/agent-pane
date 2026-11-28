/**
 * Split a JSON array held as UTF-8 bytes into its top-level elements, so each
 * one can be parsed on its own and a large document never needs one long
 * `JSON.parse` (or one giant decoded string) on the main thread.
 *
 * The scan finds boundaries only. A range is a candidate element: it must still
 * parse as JSON by itself, and a caller that gets one that does not must treat
 * the whole array as invalid, exactly as one `JSON.parse` of the document would.
 * Every structural byte JSON uses is ASCII, and no byte of a multi-byte UTF-8
 * sequence is, so splitting bytes never cuts a character in two.
 *
 * Strings are skipped with `indexOf` (native memchr), so the cost follows the
 * document's structure rather than its payload: a history whose bulk is base64
 * image data is mostly skipped, not walked byte by byte.
 */

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d

export interface JsonArrayElements {
  /** `[start, end)` byte offsets of each top-level element, whitespace included. */
  elements: Array<readonly [start: number, end: number]>
  /** Offset just past the array's closing `]`. */
  end: number
}

/** Index just past the string whose opening quote is at `open`, or -1 if it never closes. */
function skipString(bytes: Buffer, open: number): number {
  let at = open + 1
  for (;;) {
    const quote = bytes.indexOf(QUOTE, at)
    if (quote < 0) return -1
    // A quote preceded by an odd run of backslashes is escaped. The opening
    // quote bounds the run, so the walk back never leaves the string.
    let backslashes = 0
    while (bytes[quote - 1 - backslashes] === BACKSLASH) backslashes++
    if (backslashes % 2 === 0) return quote + 1
    at = quote + 1
  }
}

function isJsonWhitespace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09
}

function isBlank(bytes: Buffer, start: number, end: number): boolean {
  for (let at = start; at < end; at++) if (!isJsonWhitespace(bytes[at])) return false
  return true
}

/**
 * The elements of the array whose `[` is at `open`. Returns null when the array
 * never closes or a closing bracket does not match; an empty array (`[]`, or
 * only whitespace inside) has no elements.
 */
export function jsonArrayElements(bytes: Buffer, open: number): JsonArrayElements | null {
  if (bytes[open] !== OPEN_BRACKET) return null
  const elements: Array<readonly [number, number]> = []
  let depth = 0
  let elementStart = open + 1
  let at = open + 1
  while (at < bytes.length) {
    const byte = bytes[at]
    if (byte === QUOTE) {
      const next = skipString(bytes, at)
      if (next < 0) return null
      at = next
      continue
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      depth++
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      if (depth === 0) {
        if (byte !== CLOSE_BRACKET) return null
        // `[]` and `[ ]` hold nothing; a blank range anywhere else is a
        // missing element that the caller's parse rejects.
        if (elements.length > 0 || !isBlank(bytes, elementStart, at)) {
          elements.push([elementStart, at])
        }
        return { elements, end: at + 1 }
      }
      depth--
    } else if (byte === COMMA && depth === 0) {
      elements.push([elementStart, at])
      elementStart = at + 1
    }
    at++
  }
  return null
}
