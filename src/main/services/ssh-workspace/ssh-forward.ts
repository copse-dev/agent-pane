import { createServer } from 'node:net'

export type SshForwardAction = 'forward' | 'cancel'

/** A loopback TCP port, or a unix socket on each end. */
export type SshForwardSpec =
  | { localPort: number; remotePort: number }
  | { localSocket: string; remoteSocket: string }

function forwardSpec(spec: SshForwardSpec): string {
  if ('localSocket' in spec) return `${spec.localSocket}:${spec.remoteSocket}`
  return `127.0.0.1:${String(spec.localPort)}:127.0.0.1:${String(spec.remotePort)}`
}

/**
 * Build the control command for a forward attached to an existing multiplexed
 * SSH master. Both ends are loopback-bound, or unix sockets, so a remote
 * desktop or worker is never exposed on either machine's network interfaces.
 */
export function sshForwardControlArgs(
  controlPath: string,
  target: string,
  action: SshForwardAction,
  spec: SshForwardSpec,
): string[] {
  return ['-S', controlPath, '-O', action, '-L', forwardSpec(spec), target]
}

/** Reserve an ephemeral loopback port long enough to learn its number. */
export async function allocateLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a loopback port'))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}
