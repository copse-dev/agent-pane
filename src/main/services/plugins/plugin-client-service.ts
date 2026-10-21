import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { isPluginClientApiEnabled } from '@copse/agent/plugins/plugin-client-api-plugin.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'
import { clientActivity } from '../clients/client-activity.ts'
import { humanDecisions } from '../human-decisions.ts'
import { requestApproval } from '../approval.ts'
import { startPluginClientServer } from './plugin-client-server.ts'

let openClientThread: (projectId: string, threadId: string) => boolean = () => false

/** The desktop host supplies navigation; transports never launch another Copse process. */
export function setPluginClientThreadOpener(
  open: (projectId: string, threadId: string) => boolean,
): void {
  openClientThread = open
}

let active: Awaited<ReturnType<typeof startPluginClientServer>> | null = null
let pending = Promise.resolve()
let quitting = false
const enabled = (): boolean => !quitting && isPluginClientApiEnabled(getDefaultPluginRegistry())

/** Called at boot and after the real Settings toggle. No listener exists by default. */
export function syncPluginClientApi(): Promise<void> {
  const requested = enabled()
  pending = pending
    .then(async () => {
      const discovery = join(copseDataRoot(), 'plugin-client-api.json')
      if (!requested || !enabled()) {
        await active?.close()
        active = null
        rmSync(discovery, { force: true })
        return
      }
      if (active) return
      active = await startPluginClientServer({
        decisions: humanDecisions,
        enabled,
        activity: clientActivity,
        openThread: (projectId, threadId) => openClientThread(projectId, threadId),
        approvePair: async (label, code, signal) => {
          // This HTTP-owned prompt has no run/thread identity and is never registered in
          // the remote decision feed. A client cannot approve its own pairing request.
          const result = await requestApproval(
            {
              title: 'Connect interactive client',
              body: `Client: ${label}\nPairing code: ${code}\nScope: shell-command approvals, recent chat titles and opening those chats across all projects`,
              bodyAdvice:
                'Verify this code in the client you opened. Connecting allows this client to view and answer shell-command approval requests, read recent chat titles and open those chats across all projects. Chat content is not shared. Details may contain sensitive commands and arguments. Access ends when this plugin is disabled or Copse quits.',
              type: 'mcp',
              subject: 'Pair interactive client',
              approveLabel: 'Connect client',
              showWhileSettingsOpen: true,
              standalone: true,
            },
            signal,
          )
          return result.approved
        },
      })
      mkdirSync(copseDataRoot(), { recursive: true })
      writeFileSync(`${discovery}.tmp`, JSON.stringify({ version: 1, origin: active.origin }), {
        mode: 0o600,
      })
      renameSync(`${discovery}.tmp`, discovery)
    })
    .catch((error: unknown) => {
      console.error('[plugin-client-api] Could not synchronize service:', error)
    })
  return pending
}

export async function stopPluginClientApi(): Promise<void> {
  quitting = true
  await syncPluginClientApi()
}
