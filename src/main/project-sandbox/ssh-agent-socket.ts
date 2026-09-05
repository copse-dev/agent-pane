import { statSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'

/**
 * Unix-socket carve-out for the user's `ssh-agent` (issue #2320).
 *
 * ## The problem
 *
 * A passphrase-protected SSH signing key can only be used through `ssh-agent`:
 * `ssh-keygen -Y sign` falls back to reading the key file when it cannot reach
 * the agent, and then needs the passphrase it has no way to ask for. The seatbelt
 * denies `connect()` to the launchd agent socket, so every commit an ACP agent
 * makes lands unsigned (or the commit dies outright) even though the same commit
 * signs fine from an unsandboxed shell.
 *
 * ## Why the grant is deliberately narrow
 *
 * An agent socket is a confused-deputy channel: the sandbox still prevents the
 * agent process from *reading* the private key, but a socket lets it ask
 * ssh-agent to *use* that key, and the agent protocol has no "commit signing
 * only" scope. Whoever can reach the socket can sign arbitrary data and
 * authenticate anywhere those keys are trusted. So this is off unless the user
 * turns it on, and when on it admits exactly the one socket path
 * `SSH_AUTH_SOCK` names — never a directory, never every socket.
 *
 * Pair it with `ssh-add -c` to make each use require confirmation.
 *
 * ## Why macOS only
 *
 * ASRT expresses this differently per platform. The macOS seatbelt takes a
 * path allow-list (`network.allowUnixSockets`) and emits a `(subpath …)` filter
 * per entry, so the grant can name one socket. Linux enforces the same boundary
 * with a seccomp-bpf filter on `socket(AF_UNIX, …)`, and seccomp cannot inspect
 * user-space memory to read a socket path — so its only knob is
 * `allowAllUnixSockets`, which would open *every* unix socket in the sandbox
 * (Docker, Gradle, the display server) to buy one. That trade is not worth
 * making silently, so Linux keeps its current profile and this returns nothing
 * there. The reported failure is macOS-specific anyway: a launchd ssh-agent
 * socket reached through `SSH_AUTH_SOCK`.
 */

/**
 * The socket paths to hand ASRT's `network.allowUnixSockets`, given the raw
 * `SSH_AUTH_SOCK` value and the host platform.
 *
 * Returns an empty list — meaning "change nothing about the profile" — when the
 * caller has not enabled the carve-out, when the platform cannot express it
 * narrowly, or when the environment names no usable socket. An empty list is
 * always the safe answer: ASRT leaves unix sockets blocked when it is given
 * neither `allowUnixSockets` nor `allowAllUnixSockets`.
 *
 * `authSock`, `platform` and `isSocket` are parameters rather than reads of
 * `process.env` / `process.platform` / the filesystem, so the policy is a pure
 * function the tests can drive directly, without a test-only settings path into
 * the product. {@link resolveSshAgentSocketAllowList} is the caller-facing
 * wrapper that supplies the filesystem answer.
 */
export function sshAgentSocketAllowList(input: {
  /** Whether the user has opted this on; `false` short-circuits everything. */
  readonly enabled: boolean
  /** Raw `SSH_AUTH_SOCK` from the environment the agent will be spawned with. */
  readonly authSock: string | undefined
  /** `process.platform` of the host. */
  readonly platform: NodeJS.Platform
  /**
   * Whether the path is, right now, a unix socket. **Load-bearing, not a
   * sanity check.** ASRT emits `(subpath "<path>")` per entry, and a subpath
   * rule over a *directory* grants every socket beneath it — so a
   * `SSH_AUTH_SOCK` that names a directory (a misconfiguration, or an
   * environment an attacker influenced) would silently widen the grant far
   * past the one agent socket this feature exists to admit. `/` would admit
   * all of them. Narrowing to a real socket node keeps `subpath` and `literal`
   * equivalent, because a socket has nothing beneath it.
   */
  readonly isSocket: boolean
}): string[] {
  if (!input.enabled) return []
  // See "Why macOS only" above: on Linux the equivalent grant is all-or-nothing.
  if (input.platform !== 'darwin') return []
  const sock = input.authSock?.trim()
  if (!sock) return []
  // A relative path would resolve against the agent's cwd rather than the path
  // the seatbelt profile pins, so the grant and the connect could disagree.
  // Refuse rather than emit a rule that does not mean what it says.
  if (!isAbsolute(sock)) return []
  // Likewise for a path that is not already normalised: `/a/../b` pins one
  // string in the profile while the kernel resolves another.
  if (normalize(sock) !== sock) return []
  if (!input.isSocket) return []
  return [sock]
}

/**
 * {@link sshAgentSocketAllowList} with the filesystem question answered.
 *
 * `statSync` follows symlinks deliberately: the seatbelt matches the vnode the
 * path resolves to, so what matters is what is at the end of the link, not the
 * link itself. A missing or unreadable path throws and is treated as "not a
 * socket" — the safe reading, since the grant is only ever narrowed by it.
 */
export function resolveSshAgentSocketAllowList(input: {
  readonly enabled: boolean
  readonly authSock: string | undefined
  readonly platform: NodeJS.Platform
}): string[] {
  const sock = input.authSock?.trim()
  let isSocket = false
  if (sock) {
    try {
      isSocket = statSync(sock).isSocket()
    } catch {
      isSocket = false
    }
  }
  return sshAgentSocketAllowList({ ...input, isSocket })
}
