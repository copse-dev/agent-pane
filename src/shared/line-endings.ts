/**
 * The one line-ending policy shared by the agent's file tools.
 *
 * `read_file` shows a file with every line break (`\r\n`, lone `\r`, `\n`)
 * as `\n`, so the text a model copies into `str_replace` or `apply_patch` is
 * in that LF view. The edit tools match against the same view and write back
 * through {@link fromLfView}, which restores each untouched line's own break
 * and gives lines the edit introduced the file's dominant one.
 */

export type LineBreak = '\n' | '\r\n' | '\r'

export interface LfView {
  /** The content with every line break written as `\n`. */
  text: string
  /** The original break for each `\n` in `text`, in order. */
  breaks: LineBreak[]
  /** The most common break (ties favour `\r\n`, then `\n`); `\n` when there are none. */
  dominant: LineBreak
}

export function toLfView(content: string): LfView {
  const breaks: LineBreak[] = []
  const text = content.replace(/\r\n|\r|\n/g, (found) => {
    breaks.push(found === '\r\n' ? '\r\n' : found === '\r' ? '\r' : '\n')
    return '\n'
  })
  return { text, breaks, dominant: dominantBreak(breaks) }
}

function dominantBreak(breaks: readonly LineBreak[]): LineBreak {
  let crlf = 0
  let cr = 0
  let lf = 0
  for (const lineBreak of breaks) {
    if (lineBreak === '\r\n') crlf += 1
    else if (lineBreak === '\r') cr += 1
    else lf += 1
  }
  if (crlf > 0 && crlf >= lf && crlf >= cr) return '\r\n'
  return cr > lf ? '\r' : '\n'
}

/** Write an LF-view text back out, the i-th `\n` becoming `breaks[i]` (or `fallback`). */
export function fromLfView(
  text: string,
  breaks: readonly LineBreak[],
  fallback: LineBreak,
): string {
  let index = 0
  return text.replace(/\n/g, () => breaks[index++] ?? fallback)
}

export interface LfViewEdit {
  /** Offsets into the LF view's `text`; edits must not overlap. */
  start: number
  end: number
  replacement: string
}

/**
 * Apply edits to the LF view and return the file content with its original
 * line breaks: breaks outside every edit are kept, breaks inside an edited
 * range are dropped, and each `\n` in a replacement gets the dominant break.
 */
export function applyLfViewEdits(view: LfView, edits: readonly LfViewEdit[]): string {
  let text = view.text
  const breaks = [...view.breaks]
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    const firstBreak = countNewlines(text, 0, edit.start)
    const removed = countNewlines(text, edit.start, edit.end)
    const added = countNewlines(edit.replacement, 0, edit.replacement.length)
    breaks.splice(firstBreak, removed, ...Array.from({ length: added }, () => view.dominant))
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
  }
  return fromLfView(text, breaks, view.dominant)
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  for (let at = text.indexOf('\n', from); at !== -1 && at < to; at = text.indexOf('\n', at + 1)) {
    count += 1
  }
  return count
}
