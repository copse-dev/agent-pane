/** Advice for the specific SSH signing failure seen after a sandboxed git commit.
 * The tool result is returned to the agent in the same turn; afterToolUse hooks
 * are detached observations and cannot provide timely recovery guidance.
 */
export function scopedSshCommitSigningAdvice(
  output: string,
  options: { macOS: boolean; sandboxed: boolean; permissionEnabled: boolean },
): string | null {
  if (!options.macOS || !options.sandboxed || options.permissionEnabled) return null
  if (
    !/^error: Couldn't load public key .+$/m.test(output) &&
    !/^error: Couldn't (?:get agent socket|find key in agent)\?$/m.test(output)
  )
    return null
  if (!/^fatal: failed to write commit object$/m.test(output)) return null

  return (
    'Copse advice: SSH signing failed and Settings → Permissions → Commit signing is off. ' +
    'Ask the user to check that the configured public key exists and its matching key is ' +
    'loaded in ssh-agent. If they use ssh-agent for signing, they can enable scoped SSH ' +
    'signing approvals there and retry git_commit. Do not request a password, disable ' +
    'signing, or retry outside the sandbox.'
  )
}
