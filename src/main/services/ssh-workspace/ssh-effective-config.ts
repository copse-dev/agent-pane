/**
 * Read options from `ssh -G <host>`: the configuration OpenSSH would use for a
 * connection, after `~/.ssh/config`, its `Include`s, `Match` blocks and the
 * command line have all been applied. `-G` prints it and exits without
 * connecting, so asking never authenticates or prompts.
 */

/**
 * Whether `ssh -G` output says the connection forwards the user's SSH agent,
 * or `undefined` when the output has no `forwardagent` line (not `ssh -G`
 * output, or an OpenSSH too old to print it).
 *
 * OpenSSH prints keywords in lower case, one `keyword value` per line. Since
 * OpenSSH 8.4 `ForwardAgent` may also name a socket path or an environment
 * variable instead of `yes`: that still forwards an agent, so anything but
 * `no` counts.
 */
export function forwardAgentFromSshG(output: string): boolean | undefined {
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    const space = line.search(/\s/)
    if (space <= 0) continue
    if (line.slice(0, space).toLowerCase() !== 'forwardagent') continue
    const value = line.slice(space).trim()
    if (!value) return undefined
    return value.toLowerCase() !== 'no'
  }
  return undefined
}
