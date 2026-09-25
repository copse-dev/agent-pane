import { errorMessage } from '@shared/errors.ts'
import { unwrapIpcErrorText } from '../ipc-error-message.ts'

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

/** `Thread "<id>" does not belong to project "<id>"`, as main phrases it. */
const CROSS_PROJECT = /^Thread "[^"]*" does not belong to project "[^"]*"$/

export function terminalStartFailureMessage(err: unknown): string {
  const detail = unwrapIpcErrorText(errorMessage(err))
  if (CROSS_PROJECT.test(detail)) {
    // Deliberately no ids: they name the two records that disagree, which is a
    // fact about Copse's state rather than about anything the user did. What
    // they can act on is reopening the tab, which re-reads the pair.
    return 'This terminal was opened against a thread from another project. Close the tab and open a new one.'
  }
  return detail || 'The shell could not be started.'
}
