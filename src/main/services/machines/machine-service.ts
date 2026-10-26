import { REMOTE_SYSTEM_ONE_MODELS_SETTING } from '@shared/machines.ts'
import type { MachineStoreData } from './machine-store.ts'
import { MachineManager } from './machine-manager.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { getSecretCipher, isSecretEncryptionAvailable } from '../storage/secret-cipher.ts'
import { listClassifierProfiles, invokeClassifierBatch } from '../classifiers/classifier-service.ts'
import { getExplicitSettingsProfile } from '../storage/settings-context.ts'

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
  )
  return manager
}
export async function syncMachineService(): Promise<void> {
  if (getSetting<boolean>(REMOTE_SYSTEM_ONE_MODELS_SETTING, false)) await machineManager().restore()
  else await manager?.close()
}
export async function startMachineService(): Promise<void> {
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
