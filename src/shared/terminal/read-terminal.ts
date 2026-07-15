/** Settings key: when false, hide `read_terminal` and `@shell` mentions. */
export const READ_TERMINAL_ENABLED_SETTING = 'readTerminalEnabled'

/** Kill switch is on by default — open shells are readable unless the user opts out. */
export const READ_TERMINAL_ENABLED_DEFAULT = true

/** Default scrollback lines returned by `read_terminal` / `@shell`. */
export const READ_TERMINAL_DEFAULT_LINES = 200

/** Hard cap the agent (or `@shell`) may request in one snapshot. */
export const READ_TERMINAL_MAX_LINES = 2000

/**
 * Take the last `maxLines` lines from a multiline buffer (already ANSI-stripped).
 * Empty / whitespace-only buffers yield an empty string.
 */
export function takeLastLines(text: string, maxLines: number): string {
  const capped = Math.max(1, Math.min(Math.floor(maxLines), READ_TERMINAL_MAX_LINES))
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
  if (!normalized.trim()) return ''
  const lines = normalized.split('\n')
  if (lines.length <= capped) return normalized
  return lines.slice(lines.length - capped).join('\n')
}
