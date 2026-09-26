/**
 * The user-facing text of an error thrown across IPC. Electron prefixes
 * anything thrown inside `ipcMain.handle` with
 * "Error invoking remote method 'x:y': Error: ", which is noise for the user.
 */
export function ipcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  return (
    err.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') || fallback
  )
}
