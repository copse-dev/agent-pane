import { WORKSPACE_CONNECTION_ERROR_PREFIX } from '@shared/workspace-connection-error.ts'

/** Prepare a remote workspace inside the same barrier as its root activation. */
export async function prepareWorkspaceConnection(connection: {
  enabled: boolean
  connected: boolean
  connect: () => Promise<unknown>
}): Promise<void> {
  if (!connection.enabled) {
    throw new Error(
      `${WORKSPACE_CONNECTION_ERROR_PREFIX}Enable SSH workspaces in Settings → Machines before opening a remote folder.`,
    )
  }
  if (connection.connected) return
  try {
    await connection.connect()
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Connection unavailable'
    throw new Error(`${WORKSPACE_CONNECTION_ERROR_PREFIX}SSH connection failed: ${detail}`, {
      cause: error,
    })
  }
}
