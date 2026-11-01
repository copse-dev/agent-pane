/**
 * The real ASRT adapter for the per-download host. Kept apart from the host's
 * process entry so the native containment test drives exactly this wiring.
 */
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { isDefined } from '@shared/nullish.ts'
import { shellForSandboxWrap } from '../../../project-sandbox/sandbox-argv.ts'
import type { HostSandbox } from './host.ts'

export const asrtHostSandbox: HostSandbox = {
  async initialize(config) {
    if (process.platform === 'win32' || !SandboxManager.isSupportedPlatform()) {
      throw new Error('no sandbox backend on this platform')
    }
    // The ask-callback never grants: the allowlist is decided before startup.
    await SandboxManager.initialize(config, () => Promise.resolve(false), false)
  },
  wrap: (command) => {
    // Linux reaches the proxy through ASRT's Unix-socket bridge, created in
    // the temp directory the profile denies. Re-allow exactly those sockets:
    // without them the in-namespace socat has nothing to connect to.
    const filesystem = SandboxManager.getConfig()?.filesystem
    const bridgeSockets = [
      SandboxManager.getLinuxHttpSocketPath(),
      SandboxManager.getLinuxSocksSocketPath(),
    ].filter(isDefined)
    return SandboxManager.wrapWithSandboxArgv(
      command,
      shellForSandboxWrap(),
      filesystem && bridgeSockets.length > 0
        ? {
            filesystem: {
              ...filesystem,
              allowRead: [...new Set([...(filesystem.allowRead ?? []), ...bridgeSockets])],
            },
          }
        : undefined,
    )
  },
  reset: () => SandboxManager.reset(),
}
