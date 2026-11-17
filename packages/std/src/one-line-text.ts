/**
 * Single-line display text: collapse whitespace, then cut to a character
 * budget with a trailing `…`. Lengths count UTF-16 code units, as
 * `String#length` and `String#slice` do.
 */

/** Every run of whitespace (newlines included) becomes one space; the ends are trimmed. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export interface EllipsizeOptions {
  /** Drop whitespace left at the cut, so the result never reads `word …`. */
  trimEnd?: boolean
}

/**
 * `text` unchanged when it fits in `max` characters; otherwise its first
 * `max - 1` characters and `…`, so the result is exactly `max` long (shorter
 * with `trimEnd`). Callers that cut at `max` and then append `…` produce one
 * character more and are a different contract.
 */
export function ellipsize(text: string, max: number, options: EllipsizeOptions = {}): string {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  return `${options.trimEnd === true ? head.trimEnd() : head}…`
}

/** {@link collapseWhitespace} then {@link ellipsize}: one line of at most `max` characters. */
export function truncateLine(text: string, max: number): string {
  return ellipsize(collapseWhitespace(text), max)
}
