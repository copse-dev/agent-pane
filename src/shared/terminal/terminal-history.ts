/**
 * Settings key: whether interactive terminal PTYs opened for the same project
 * share one command-history file. See `terminal-history-env.ts` (#2433) — this
 * only touches the PTY's environment, never a shell rc file.
 */
export const SHARE_TERMINAL_HISTORY_ENABLED_SETTING = 'shareTerminalHistoryEnabled'

/** On by default — a command typed in one thread's terminal is recallable in the next. */
export const SHARE_TERMINAL_HISTORY_ENABLED_DEFAULT = true

/** Filename of the shared bash/zsh history file under a project's store directory. */
export const TERMINAL_HISTORY_FILENAME = 'terminal-history'

/**
 * fish keys history by session name (`fish_history`), not by a file path, so a
 * per-project name is fish's equivalent of a per-project `HISTFILE`.
 */
export function fishHistorySessionName(projectId: string): string {
  return `copse-${projectId}`
}
