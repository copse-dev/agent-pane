import { DARK_FACTORY_PACK_ID } from '@copse/agent/packs/dark-factory-pack.ts'
import { getDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import type { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import type { TaskSupervisor } from './task-supervisor.ts'

export const DARK_FACTORY_FLEET_SOURCE = 'dark-factory:fleet'
export const DARK_FACTORY_POLL_EVENT = 'dark-factory:fleet-poll'

export type FleetPollUrgency = 'pending' | 'failure' | 'idle'

const POLL_INTERVAL_MS: Readonly<Record<FleetPollUrgency, number>> = {
  pending: 60_000,
  failure: 5 * 60_000,
  idle: 15 * 60_000,
}

export interface DarkFactorySensorClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number
  clearTimeout(handle: ReturnType<typeof setTimeout> | number): void
}

export interface DarkFactorySensorDependencies {
  clock?: DarkFactorySensorClock
  readUrgency?: () => FleetPollUrgency
  random?: () => number
}

const systemClock: DarkFactorySensorClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle)
  },
}

function jitteredDelay(baseMs: number, random: () => number): number {
  const factor = 0.9 + random() * 0.2
  return Math.round(baseMs * factor)
}

export class DarkFactorySensorController {
  private readonly supervisor: TaskSupervisor
  private readonly packRegistry: PackRegistry
  private readonly clock: DarkFactorySensorClock
  private readonly readUrgency: () => FleetPollUrgency
  private readonly random: () => number
  private releaseSource: (() => void) | undefined

  constructor(
    supervisor: TaskSupervisor,
    packRegistry: PackRegistry,
    dependencies: DarkFactorySensorDependencies = {},
  ) {
    this.supervisor = supervisor
    this.packRegistry = packRegistry
    this.clock = dependencies.clock ?? systemClock
    this.readUrgency = dependencies.readUrgency ?? ((): FleetPollUrgency => 'idle')
    this.random = dependencies.random ?? Math.random
  }

  sync(): void {
    const enabled = this.packRegistry.isEnabled(DARK_FACTORY_PACK_ID)
    if (!enabled) {
      this.releaseSource?.()
      this.releaseSource = undefined
      return
    }
    if (this.releaseSource) return
    this.releaseSource = this.supervisor.registerEventSource(
      DARK_FACTORY_FLEET_SOURCE,
      (emit): (() => void) => {
        let timer: ReturnType<typeof setTimeout> | number | undefined
        let stopped = false
        const schedule = (): void => {
          const delay = jitteredDelay(POLL_INTERVAL_MS[this.readUrgency()], this.random)
          timer = this.clock.setTimeout((): void => {
            if (stopped) return
            emit(DARK_FACTORY_POLL_EVENT)
            schedule()
          }, delay)
        }
        schedule()
        return () => {
          stopped = true
          if (timer !== undefined) this.clock.clearTimeout(timer)
        }
      },
    )
  }

  dispose(): void {
    this.releaseSource?.()
    this.releaseSource = undefined
  }
}

let installedController: DarkFactorySensorController | undefined

export function installDarkFactorySensor(
  supervisor: TaskSupervisor,
  packRegistry = getDefaultPackRegistry(),
): () => void {
  installedController?.dispose()
  const controller = new DarkFactorySensorController(supervisor, packRegistry)
  installedController = controller
  controller.sync()
  return () => {
    if (installedController !== controller) return
    controller.dispose()
    installedController = undefined
  }
}

export function syncDarkFactorySensor(): void {
  installedController?.sync()
}
