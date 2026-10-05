import type { ClassifierProfile } from '@copse/llm/classifiers/types.ts'
import { listClassifierProfiles, saveClassifierProfile } from './classifier-service.ts'
import {
  LocalClassifierManager,
  defaultSleep,
  spawnLocalServer,
} from './local-classifier-manager.ts'
import {
  isClassifierInstalled,
  portListening,
  prepareClassifierCache,
  programAvailable,
} from './local-server.mts'

let manager: LocalClassifierManager | undefined

/** The app's one manager. Created on first use so launching Copse probes nothing. */
export function localClassifiers(): LocalClassifierManager {
  manager ??= new LocalClassifierManager({
    prepare: prepareClassifierCache,
    isInstalled: isClassifierInstalled,
    portListening,
    programAvailable,
    spawnServer: spawnLocalServer,
    listProfiles: (): ClassifierProfile[] => listClassifierProfiles().map((item) => item.profile),
    saveProfile: saveClassifierProfile,
    env: process.env,
    sleep: defaultSleep,
  })
  return manager
}

/** Stop servers Copse started. Safe to call when none was ever used. */
export function stopLocalClassifierServers(): void {
  manager?.stopAll()
}
