/**
 * Detect a real POSIX pipeline in a shell command and, where the executing shell
 * is known to honor it, enable `pipefail` so a failing producer piped into
 * `tail`/`head` surfaces as a non-zero exit instead of being masked as success
 * (issue #787).
 *
 * Without pipefail, `/bin/sh -c "xcodebuild … | tail -100"` reports `tail`'s exit
 * status (0), so run_shell reports success and never offers the unsandboxed
 * retry — hiding a real sandbox-blocked build failure.
 */

export interface PipefailContext {
  /** Host platform of the executing shell. */
  platform: NodeJS.Platform
  /** The command runs on a remote (SSH) host whose shell we do not control. */
  isRemote: boolean
}

/**
 * True when `command` contains a pipe operator (`|`, but not `||`) that is a real
 * shell operator — i.e. outside single/double quotes and not backslash-escaped.
 * A literal `|` inside quotes or after a backslash is data, not a pipeline, and
 * must not trigger pipefail (e.g. `echo "a|b"`, `grep 'a\|b'`).
 */
export function hasUnquotedPipeline(command: string): boolean {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      // POSIX single quotes: nothing is special, only another `'` closes.
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      // In double quotes a backslash may escape the next char (e.g. \"); skip it
      // so an escaped quote does not look like the closing quote.
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '"') quote = null
      continue
    }
    // Unquoted.
    if (ch === '\\') {
      i++ // Escaped char (including `\|`) is literal.
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '|') {
      // `||` is logical OR, not a pipeline. `|&` (pipe including stderr) is one.
      if (command[i + 1] === '|') {
        i++
        continue
      }
      return true
    }
  }
  return false
}

/** A command that already manages pipefail itself is left untouched. */
function alreadyControlsPipefail(command: string): boolean {
  return /\bpipefail\b/.test(command)
}

/**
 * Return `command` prefixed with `set -o pipefail` when it contains a real
 * pipeline and the shell is known to honor pipefail; otherwise return it
 * unchanged. Injection is deliberately conservative:
 *
 *   - Remote (SSH) targets: the remote shell's pipefail support is unknown, so
 *     behavior is preserved (a capability probe is future work).
 *   - Non-macOS: local `/bin/sh` is frequently dash, where `set -o pipefail` is
 *     an invalid option that ABORTS a non-interactive shell — injecting it would
 *     break every pipeline. Behavior is preserved there.
 *   - macOS: both the unsandboxed `/bin/sh` (bash in POSIX mode) and the
 *     sandbox's `/bin/bash` honor pipefail, so the identical transform is safe
 *     for the sandboxed run and any approved unsandboxed retry.
 *
 * The user's command bytes are preserved verbatim after the prefix.
 */
export function maybeEnablePipefail(command: string, ctx: PipefailContext): string {
  if (ctx.isRemote) return command
  if (ctx.platform !== 'darwin') return command
  if (alreadyControlsPipefail(command)) return command
  if (!hasUnquotedPipeline(command)) return command
  return `set -o pipefail\n${command}`
}

/** True when {@link maybeEnablePipefail} added the prefix to this command. */
export function pipefailWasInjected(command: string, executedCommand: string): boolean {
  return executedCommand !== command
}

/** Exit status of a process killed by SIGPIPE: 128 + 13. */
export const SIGPIPE_EXIT_CODE = 141

/**
 * True when a non-zero status is *only* pipefail reporting a producer that died
 * of SIGPIPE because a downstream consumer closed the pipe early.
 *
 * `cmd | head -50` is the canonical case: once `head` has its 50 lines it exits,
 * `cmd` gets SIGPIPE, and pipefail promotes that 141 to the pipeline's status.
 * The output is complete and correct — `head` got exactly what it asked for —
 * but run_shell would report the command as failed, which is worse than the
 * masking pipefail exists to prevent (issue #787): an agent told its own
 * diagnostic command failed will re-run it, or thrash trying to "fix" a build
 * that was never broken.
 *
 * Only trusted where we injected pipefail ourselves. A command that set pipefail
 * by hand, or a remote shell, keeps whatever status it reported — the user's own
 * `set -o pipefail` is a deliberate choice we must not second-guess.
 */
export function isSigpipeOnlyFailure(exitCode: number, pipefailInjected: boolean): boolean {
  return pipefailInjected && exitCode === SIGPIPE_EXIT_CODE
}
