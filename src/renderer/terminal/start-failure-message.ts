import { errorMessage } from '@shared/errors.ts'

/**
 * What to print in the terminal when a shell will not start.
 *
 * The raw value is an Electron IPC rejection, and printing it verbatim gave the
 * user
 *
 *   Failed to start terminal: Error: Error invoking remote method
 *   'terminal:create': Error: Thread "ec57a9a6-…" does not belong to project
 *   "e2e-mermaid-project"
 *
 * — three nested error prefixes, an IPC channel name, and two UUIDs, none of
 * which is anything they can act on (#2484). The report's own words were
 * "unsure what is causing this terminal to not work".
 *
 * So the wrapping comes off, and the one failure the user cannot diagnose from
 * its own text gets said plainly. Everything else keeps its message: an unknown
 * failure is more useful shown than swallowed, and the log still carries the
 * original.
 */

/**
 * Electron wraps a main-process throw as
 * `Error invoking remote method '<channel>': <original>`, and `String(err)`
 * prefixes each layer with `Error: `. Peel both, repeatedly — the nesting is
 * two deep today and there is no reason to depend on that.
 */
function unwrapIpcError(raw: string): string {
  let message = raw
  for (;;) {
    const next = message
      .replace(/^Error:\s*/, '')
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
    if (next === message) return message.trim()
    message = next
  }
}

/** `Thread "<id>" does not belong to project "<id>"`, as main phrases it. */
const CROSS_PROJECT = /^Thread "[^"]*" does not belong to project "[^"]*"$/

export function terminalStartFailureMessage(err: unknown): string {
  const detail = unwrapIpcError(errorMessage(err))
  if (CROSS_PROJECT.test(detail)) {
    // Deliberately no ids: they name the two records that disagree, which is a
    // fact about Copse's state rather than about anything the user did. What
    // they can act on is reopening the tab, which re-reads the pair.
    return 'This terminal was opened against a thread from another project. Close the tab and open a new one.'
  }
  return detail || 'The shell could not be started.'
}
