/**
 * Detect when a shell command failed because the macOS project sandbox blocked it.
 *
 * SECURITY (issue #104): this detection must NOT use command-controlled stdout/stderr.
 * A command can trivially `echo "operation not permitted"` to fake a sandbox failure
 * and socially-engineer the user into approving an unsandboxed re-run (full env, full
 * network). We therefore key the decision off runner/exit signals only:
 *   - `violationCount`: how many sandbox policy violations the ASRT runner/kernel logged
 *     for this exact command (a side channel the command cannot write to), and
 *   - `spawnFailed`: the sandbox wrapper process itself failed to start (e.g. the ASRT
 *     binary errored), surfaced from the child-process 'error' event, not from output.
 */

export interface SandboxFailureSignals {
  /** Exit code of the (sandboxed) command; null if it never exited cleanly. */
  exitCode: number | null
  /** Sandbox policy violations the runner recorded for this command (runner-side). */
  violationCount: number
  /** The sandbox wrapper process failed to spawn/start (child 'error' event). */
  spawnFailed?: boolean
}

export interface SandboxFailureDetection {
  likely: boolean
  reasons: string[]
}

export function detectSandboxFailure(signals: SandboxFailureSignals): SandboxFailureDetection {
  const reasons: string[] = []

  if (signals.spawnFailed) {
    reasons.push('the sandbox wrapper failed to start the command')
  }

  // A non-zero exit combined with one or more runner-logged policy violations is a
  // trustworthy "the sandbox blocked this" signal. A zero exit means the command
  // succeeded regardless of any incidental violations, so never offer an escape.
  if (signals.exitCode !== 0 && signals.violationCount > 0) {
    reasons.push(
      signals.violationCount === 1
        ? 'the OS sandbox blocked 1 operation this command attempted'
        : `the OS sandbox blocked ${String(signals.violationCount)} operations this command attempted`,
    )
  }

  return { likely: reasons.length > 0, reasons: [...new Set(reasons)] }
}

export function formatUnsandboxedPromptBody(command: string, reasons: string[]): string {
  const detail = reasons.length ? reasons.join('; ') : 'sandbox restriction suspected'
  return (
    `This command failed inside the macOS project sandbox (${detail}).\n\n` +
    `${command}\n\n` +
    `Allow running it once without sandbox restrictions?`
  )
}
