/**
 * Electron wraps anything thrown inside `ipcMain.handle` as
 * `Error invoking remote method '<channel>': <original>`, and `String(err)`
 * prefixes each layer with `Error: `. Neither the channel name nor the nested
 * prefixes mean anything to the user, so peel both, repeatedly — the nesting is
 * two deep in places today and there is no reason to depend on that.
 */
export function unwrapIpcErrorText(text: string): string {
  let message = text
  for (;;) {
    const next = message
      .trimStart()
      .replace(/^Error:\s*/, '')
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
    if (next === message) return message.trim()
    message = next
  }
}

/**
 * The user-facing text of an error thrown across IPC, without Electron's
 * remote-method wrapping. `fallback` covers a non-`Error` throw and an error
 * whose text is empty once unwrapped.
 */
export function ipcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  return unwrapIpcErrorText(err.message) || fallback
}
