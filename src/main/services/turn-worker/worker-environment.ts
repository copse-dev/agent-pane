/**
 * Strip what the worker must not hand to the commands a turn runs:
 *
 * - `ELECTRON_RUN_AS_NODE`, which the launcher sets so the app binary runs as
 *   Node; inherited, any Electron program a command starts would run as plain
 *   Node. The worker's own Node children set it for themselves.
 * - The user's `SSH_ASKPASS`: the worker has no terminal and serves no askpass
 *   bridge, so OpenSSH would open the desktop's password dialog for an
 *   unattended turn. With `SSH_ASKPASS_REQUIRE=never` a host that needs a typed
 *   secret fails instead.
 */
export function quietWorkerEnvironment(env: NodeJS.ProcessEnv): void {
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['SSH_ASKPASS']
  env['SSH_ASKPASS_REQUIRE'] = 'never'
}
