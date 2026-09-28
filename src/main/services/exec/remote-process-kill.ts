import { getSshConnectionManager } from '../ssh-workspace/connection-manager.ts'

/** Send TERM then KILL to a remote process group over the SSH connection. */
export async function killRemoteProcessGroup(hostId: string, pgid: number): Promise<void> {
  const conn = getSshConnectionManager().getConnection(hostId)
  if (!conn) {
    throw new Error(`Cannot clean up remote process group: SSH host ${hostId} is disconnected`)
  }
  const id = String(pgid)
  const result = await conn.execShell(
    `kill -TERM -- -${id} 2>/dev/null; sleep 1; kill -KILL -- -${id} 2>/dev/null || true`,
  )
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Remote process cleanup exited with code ${String(result.code)}`,
    )
  }
}
