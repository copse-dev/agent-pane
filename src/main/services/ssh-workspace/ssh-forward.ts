import { createServer } from 'node:net'

export type SshForwardAction = 'forward' | 'cancel'

export interface SshForwardSpec {
  localPort: number
  remotePort: number
}

/**
 * Build the control command for a forward attached to an existing multiplexed
 * SSH master. Both ends are loopback-bound so a remote desktop is never exposed
 * on either machine's network interfaces.
 */
export function sshForwardControlArgs(
  controlPath: string,
  target: string,
  action: SshForwardAction,
  spec: SshForwardSpec,
): string[] {
  return [
    '-S',
    controlPath,
    '-O',
    action,
    '-L',
    `127.0.0.1:${String(spec.localPort)}:127.0.0.1:${String(spec.remotePort)}`,
    target,
  ]
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
