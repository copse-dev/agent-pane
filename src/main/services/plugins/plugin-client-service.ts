import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { isPluginClientApiEnabled } from '@copse/agent/plugins/plugin-client-api-plugin.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'
import { humanDecisions } from '../human-decisions.ts'
import { requestApproval } from '../approval.ts'
import { startPluginClientServer } from './plugin-client-server.ts'

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
        approvePair: async (label, code, signal) => {
          // This HTTP-owned prompt has no run/thread identity and is never registered in
          // the remote decision feed. A client cannot approve its own pairing request.
          const result = await requestApproval(
            {
              title: 'Connect interactive client',
              body: `Client: ${label}\nPairing code: ${code}\nScope: shell-command approval requests across all projects`,
              bodyAdvice:
                'Verify this code in the client you opened. Approval details may contain sensitive commands and arguments. Access ends when this plugin is disabled or Copse quits.',
              type: 'mcp',
              subject: 'Pair interactive client',
              allowRemember: true,
              rememberLabel: 'Also allow submitting approval decisions for this session',
              approveLabel: 'Connect client',
              showWhileSettingsOpen: true,
            },
            signal,
          )
          return result.approved ? (result.remember ? 'control' : 'read') : null
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
