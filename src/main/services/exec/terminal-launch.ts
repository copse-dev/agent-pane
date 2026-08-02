/**
 * Seam for "open a shell in the Shells pane and run this command".
 *
 * The PTY itself is created by the renderer (`terminals-pane.ts` owns the xterm
 * tab that would display it), so main-process code that wants to hand the user a
 * running command — the ACP re-authentication offer, today — asks the renderer to
 * open one rather than spawning a headless PTY nobody can see or type into.
 * Mirrors `ask-user.ts`: the GUI registers a launcher at startup, and with none
 * registered (headless host, window torn down) the request is a no-op that
 * reports it did nothing, so callers can avoid offering what they cannot deliver.
 */
export type TerminalCommandLauncher = (command: string) => void

let launcher: TerminalCommandLauncher | null = null

export function setTerminalCommandLauncher(next: TerminalCommandLauncher | null): void {
  launcher = next
}

/** Whether a surface capable of showing the command is currently attached. */
export function canRunTerminalCommand(): boolean {
  return launcher !== null
}

/**
 * Open a fresh shell running `command`. Returns whether the request reached a
 * launcher — a blank command or a headless host returns `false` rather than
 * pretending a terminal opened.
 */
export function requestTerminalCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || !launcher) return false
  launcher(trimmed)
  return true
}
