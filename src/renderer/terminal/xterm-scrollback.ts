/**
 * Minimal xterm buffer surface used when snapshotting scrollback for `@shell`
 * and auto-naming — keeps unit tests free of a real Terminal instance.
 */
export interface XtermScrollbackSource {
  buffer: {
    active: {
      length: number
      getLine(i: number): { translateToString(trimRight: boolean): string } | undefined
    }
  }
}

/**
 * Read ANSI-free text from an xterm buffer, capped to the last `maxLines` rows.
 */
export function readXtermScrollback(term: XtermScrollbackSource, maxLines: number): string {
  const buf = term.buffer.active
  const end = buf.length
  const start = Math.max(0, end - Math.max(1, Math.floor(maxLines)))
  const lines: string[] = []
  for (let i = start; i < end; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  }
  return lines.join('\n').trim()
}
