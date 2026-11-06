import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { SupervisedTaskMeta } from '@shared/supervisor/task-schema.ts'
import { storageSet } from '../services/storage/storage.ts'
import type {
  LoadedSupervisedTasks,
  SupervisedTaskStore,
} from '../services/supervisor/task-store.ts'
import { TaskSupervisor } from '../services/supervisor/task-supervisor.ts'
import { InstalledXcodeDriver } from '../services/apple-development/apple-driver.ts'
import { AppleDevelopmentService } from '../services/apple-development/apple-development-service.ts'
import { stopAppleWorkWhenTurnedOff } from './plugin-handlers.ts'

const PROJECTS = ['project-a', 'project-b', 'project-c']

/** An Apple operation in `projectId`, parked on a wake far in the future. */
function waitingAppleTask(projectId: string): SupervisedTaskMeta {
  return {
    taskId: `operation-${projectId}`,
    projectId,
    threadId: 'thread-1',
    handler: 'apple_operation',
    handlerInput: {},
    provenance: 'agent',
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    trigger: { kind: 'wake_at', wakeAt: Date.now() + 60 * 60 * 1_000 },
    permissionSnapshot: {
      capturedAt: 1,
      autoRunSandboxCommands: false,
      projectSandboxEnabled: false,
      executionRoot: `/${projectId}`,
      workspaceTargetKind: 'local',
    },
    reapproveOnWake: false,
    concurrencyClass: `apple:/${projectId}`,
    resourceBudget: { maxDurationMs: 30 * 60 * 1_000, maxAttempts: 1 },
    attempt: 0,
    maxAttempts: 1,
  }
}

/** Loads `tasks` once and finds them by their own project; transitions are dropped. */
function seededTaskStore(tasks: SupervisedTaskMeta[]): SupervisedTaskStore {
  const loaded = (): Promise<LoadedSupervisedTasks> => Promise.resolve({ tasks, diagnostics: [] })
  return {
    loadAll: loaded,
    loadProject: () => Promise.resolve({ tasks: [], diagnostics: [] }),
    get: () => Promise.resolve(null),
    findPersisted: (projectId, taskId) =>
      Promise.resolve(
        tasks.find((task) => task.projectId === projectId && task.taskId === taskId) ?? null,
      ),
    saveTransition: () => Promise.resolve(),
    compactTerminalTasks: () => Promise.resolve(0),
    loadTaskArchive: () => Promise.resolve([]),
  }
}

afterEach(() => {
  storageSet('activeProjectId', null)
})

describe('stopAppleWorkWhenTurnedOff', () => {
  it("cancels every project's Apple work, each under its own project, not just the active one", async () => {
    // The primary window shows project-a; the other projects' work must stop too.
    storageSet('activeProjectId', 'project-a')
    const supervisor = new TaskSupervisor({
      store: seededTaskStore(PROJECTS.map(waitingAppleTask)),
      // A clock that never fires: the far-future wakes must stay waiting.
      clock: {
        now: (): number => Date.now(),
        setTimeout: (): number => 0,
        clearTimeout: (): void => {},
      },
    })
    const service = new AppleDevelopmentService({
      driver: new InstalledXcodeDriver(),
      supervisor,
      pluginEnabled: (): boolean => false,
      platform: 'darwin',
    })
    await supervisor.start()
    const states = (): Array<string | undefined> =>
      PROJECTS.map((projectId) => supervisor.get(projectId, `operation-${projectId}`)?.state)

    await stopAppleWorkWhenTurnedOff(true, service)
    assert.deepEqual(states(), ['waiting', 'waiting', 'waiting'])

    await stopAppleWorkWhenTurnedOff(false, service)
    assert.deepEqual(states(), ['cancelled', 'cancelled', 'cancelled'])
  })
})
