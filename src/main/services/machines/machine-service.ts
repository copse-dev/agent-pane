import { REMOTE_SYSTEM_ONE_MODELS_SETTING, type MachineSshRoutes } from '@shared/machines.ts'
import type { MachineStoreData } from './machine-store.ts'
import { MachineManager, type MachineSshReach } from './machine-manager.ts'
import { getSshConnectionManager } from '../ssh-workspace/connection-manager.ts'
import { findConfiguredSshHost } from '../ssh-workspace/hosts.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { getSecretCipher, isSecretEncryptionAvailable } from '../storage/secret-cipher.ts'
import { listClassifierProfiles, invokeClassifierBatch } from '../classifiers/classifier-service.ts'
import { getExplicitSettingsProfile } from '../storage/settings-context.ts'

/**
 * Paired machines reached over SSH use a forward on the saved host's existing
 * multiplexed master to the machine's loopback listener: no new listener, and
 * nothing the machine checks changes. A status check or a screening or
 * background classifier call (`interactive: false`) uses only a connection that
 * is already open, so nothing a person didn't start prompts.
 */
export const machineSshReach: MachineSshReach = {
  async open(hostId, remotePort, { interactive }) {
    const connections = getSshConnectionManager()
    const connection =
      connections.getConnection(hostId) ?? (interactive ? await connections.connect(hostId) : null)
    if (!connection) throw new Error('not connected')
    const { localPort } = await connection.transport.openForward(remotePort)
    return {
      target: { host: '127.0.0.1', port: localPort },
      close: () => connection.transport.closeForward(localPort),
    }
  },
  label: (hostId) => findConfiguredSshHost(hostId)?.label ?? null,
}

let manager: MachineManager | undefined
let timer: ReturnType<typeof setInterval> | undefined
export function machineManager(): MachineManager {
  if (getExplicitSettingsProfile())
    throw new Error(
      'Paired machines require the desktop profile; this isolated run cannot access its credentials.',
    )
  manager ??= new MachineManager(
    {
      enabled: (): boolean => getSetting<boolean>(REMOTE_SYSTEM_ONE_MODELS_SETTING, false),
      load: (): MachineStoreData | null =>
        getSetting<MachineStoreData | null>('machineConnections', null),
      save: (value): Promise<void> => setSetting('machineConnections', value),
      routes: (): MachineSshRoutes => getSetting<MachineSshRoutes>('machineSshRoutes', {}),
      saveRoutes: (value): Promise<void> => setSetting('machineSshRoutes', value),
      available: isSecretEncryptionAvailable,
      seal: (value): string => {
        const cipher = getSecretCipher()
        if (!cipher?.isEncryptionAvailable())
          throw new Error('Unlock secure storage before using paired machines.')
        return cipher.encryptString(value).toString('base64')
      },
      open: (value): string => {
        const cipher = getSecretCipher()
        if (!cipher?.isEncryptionAvailable())
          throw new Error('Unlock secure storage to reconnect this machine.')
        return cipher.decryptString(Buffer.from(value, 'base64'))
      },
    },
    () => listClassifierProfiles().map(({ profile }) => profile),
    async (id, request, signal) => {
      const [result] = await invokeClassifierBatch(id, [request], { signal })
      if (!result) throw new Error('Shared model returned no result.')
      return result
    },
    undefined,
    machineSshReach,
  )
  return manager
}
export async function syncMachineService(): Promise<void> {
  if (getSetting<boolean>(REMOTE_SYSTEM_ONE_MODELS_SETTING, false)) await machineManager().restore()
  else await manager?.close()
}
/**
 * The saved SSH hosts changed: mark the paired-machine routes whose host is
 * gone, so a host saved later under the same label never inherits them. Also
 * run at start, for a host removed while Copse was closed. The isolated
 * settings profile has no paired machines.
 */
export async function forgetRemovedMachineSshHosts(): Promise<void> {
  if (getExplicitSettingsProfile()) return
  await machineManager().forgetRemovedSshHosts()
}
export async function startMachineService(): Promise<void> {
  await forgetRemovedMachineSshHosts()
  await syncMachineService()
  timer ??= setInterval(() => {
    void syncMachineService().catch(() => undefined)
  }, 5000)
  timer.unref()
}
export async function stopMachineService(): Promise<void> {
  clearInterval(timer)
  timer = undefined
  await manager?.close()
}
