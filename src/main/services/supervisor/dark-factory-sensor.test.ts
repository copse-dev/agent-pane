import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import { DARK_FACTORY_PACK_ID, darkFactoryPack } from '@copse/agent/packs/dark-factory-pack.ts'
import type { LoadedSupervisedTasks, SupervisedTaskStore } from './task-store.ts'
import type {
  SupervisedTaskAuditEvent,
  SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import { TaskSupervisor, type SupervisedTaskHandlerResult } from './task-supervisor.ts'
import {
  DARK_FACTORY_POLL_EVENT,
  DarkFactorySensorController,
  type DarkFactorySensorClock,
  type FleetPollUrgency,
} from './dark-factory-sensor.ts'

class EmptyTaskStore implements SupervisedTaskStore {
  loadAll(): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({ tasks: [], diagnostics: [] })
  }
  loadProject(): Promise<LoadedSupervisedTasks> {
    return Promise.resolve({ tasks: [], diagnostics: [] })
  }
  get(): Promise<SupervisedTaskMeta | null> {
    return Promise.resolve(null)
  }
  saveTransition(_meta: SupervisedTaskMeta, _audit: SupervisedTaskAuditEvent): Promise<void> {
    return Promise.resolve()
  }
}

class SensorClock implements DarkFactorySensorClock {
  readonly scheduled: Array<{ callback: () => void; delayMs: number }> = []
  readonly cleared: Array<ReturnType<typeof setTimeout> | number> = []

  setTimeout(callback: () => void, delayMs: number): number {
    this.scheduled.push({ callback, delayMs })
    return this.scheduled.length
  }
  clearTimeout(handle: ReturnType<typeof setTimeout> | number): void {
    this.cleared.push(handle)
  }
}

describe('dark-factory fleet sensor', () => {
  it('stays inert while disabled and delivers one adaptive fleet event while enabled', async () => {
    const registry = new PackRegistry()
    registry.register(darkFactoryPack)
    registry.disable(DARK_FACTORY_PACK_ID)
    const supervisor = new TaskSupervisor({ store: new EmptyTaskStore() })
    const clock = new SensorClock()
    let urgency: FleetPollUrgency = 'idle'
    const sensor = new DarkFactorySensorController(supervisor, registry, {
      clock,
      readUrgency: (): FleetPollUrgency => urgency,
      random: (): number => 0.5,
    })
    let runs = 0
    supervisor.registerHandler('fleet-observer', (): Promise<SupervisedTaskHandlerResult> => {
      runs++
      return Promise.resolve({})
    })
    await supervisor.enqueue({
      projectId: 'project-1',
      threadId: 'fleet-observer',
      handler: 'fleet-observer',
      provenance: 'system',
      trigger: { kind: 'event', event: DARK_FACTORY_POLL_EVENT },
      permissionSnapshot: {
        capturedAt: 1,
        autoRunSandboxCommands: false,
        projectSandboxEnabled: false,
      },
      reapproveOnWake: false,
      concurrencyClass: 'network',
      maxAttempts: 1,
    })

    sensor.sync()
    assert.equal(clock.scheduled.length, 0)

    registry.enable(DARK_FACTORY_PACK_ID)
    sensor.sync()
    sensor.sync()
    assert.deepEqual(
      clock.scheduled.map(({ delayMs }) => delayMs),
      [15 * 60_000],
    )

    urgency = 'pending'
    clock.scheduled[0]?.callback()
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    await supervisor.waitForIdle()
    assert.equal(runs, 1)
    assert.deepEqual(
      clock.scheduled.map(({ delayMs }) => delayMs),
      [15 * 60_000, 60_000],
    )

    registry.disable(DARK_FACTORY_PACK_ID)
    sensor.sync()
    assert.deepEqual(clock.cleared, [2])
  })
})
