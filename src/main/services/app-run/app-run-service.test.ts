import type { AppRunDriverDiscovery, AppRunDriverResult } from './app-run-driver.ts'
import type { AppRunDevice, AppRunSetupOptions } from '@shared/types/app-run.ts'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { storageDelete, storageSet } from '../storage/storage.ts'
import { AppRunService } from './app-run-service.ts'
import type { AppRunDriver, AppRunProgress } from './app-run-driver.ts'
import type {
  AppRunAction,
  AppRunApp,
  AppRunOwner,
  AppRunSelection,
} from '@shared/types/app-run.ts'

const owner: AppRunOwner = { projectId: 'project', threadId: 'thread' }
const selection: AppRunSelection = {
  appId: 'android:app',
  deviceId: 'android-avd:phone',
  variant: 'Debug',
  configuration: 'Debug',
  provisioningUpdates: false,
}
class Driver implements AppRunDriver {
  finish: (() => void) | undefined
  aborted = false
  stopped: string[] = []
  progress: AppRunProgress | undefined
  root = ''
  detect = async (): Promise<boolean> => true
  discover = async (): Promise<AppRunDriverDiscovery> => ({
    apps: [
      {
        id: 'android:app',
        platform: 'android' as const,
        name: 'Sample',
        location: 'app',
        variants: ['Debug'],
      },
    ],
    devices: [],
    issues: [],
  })
  devices = async (): Promise<AppRunDevice[]> => [
    {
      id: 'android-avd:phone',
      platform: 'android' as const,
      name: 'Phone',
      runtime: 'Android',
      state: 'stopped' as const,
    },
  ]
  async execute(
    root: string,
    _app: AppRunApp,
    _selection: AppRunSelection,
    _action: AppRunAction,
    _id: string,
    progress: AppRunProgress,
    signal: AbortSignal,
  ): Promise<AppRunDriverResult> {
    this.root = root
    this.progress = progress
    progress.stage('building')
    progress.log('Compiling sample\n')
    await new Promise<void>((resolve, reject) => {
      this.finish = resolve
      signal.addEventListener(
        'abort',
        () => {
          this.aborted = true
          reject(new Error('Cancelled'))
        },
        { once: true },
      )
    })
    progress.stage('launching')
    return { desktopId: 'android:123', appSessionId: 'session' }
  }
  async stop(_root: string, id: string): Promise<void> {
    this.stopped.push(id)
  }
  setupOptions = async (): Promise<AppRunSetupOptions> => ({ runtimes: [], deviceTypes: [] })
  setup = async (): Promise<void> => {}
}
const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
const services: AppRunService[] = []
beforeEach(() => {
  storageDelete('app-run.state')
})
afterEach(() => {
  for (const service of services) service.dispose()
  services.length = 0
  storageDelete('app-run.state')
})
function fixture(): {
  service: AppRunService
  driver: Driver
  presented: { id: string; owner: AppRunOwner }[]
  changeRoot: () => void
} {
  const driver = new Driver()
  const empty: AppRunDriver = {
    detect: async (): Promise<boolean> => false,
    discover: driver.discover,
    devices: driver.devices,
    execute: driver.execute.bind(driver),
    stop: driver.stop.bind(driver),
    setupOptions: driver.setupOptions,
    setup: driver.setup,
  }
  let root = '/work/thread'
  const presented: { id: string; owner: AppRunOwner }[] = []
  const service = new AppRunService({
    drivers: { android: driver, apple: empty },
    resolveRoot: async (): Promise<string> => root,
    present: async (id, context): Promise<void> => {
      presented.push({ id, owner: context })
    },
  })
  services.push(service)
  return {
    service,
    driver,
    presented,
    changeRoot: (): void => {
      root = '/work/replaced'
    },
  }
}
describe('shared app running', () => {
  it('detects generated apps in the selected thread checkout', async () => {
    const driver = new Driver()
    driver.detect = async (root?: string): Promise<boolean> => root === '/work/generated'
    const service = new AppRunService({
      drivers: { android: driver, apple: driver },
      resolveRoot: async (context): Promise<string> =>
        context.threadId ? '/work/generated' : '/work/original',
    })
    services.push(service)
    assert.equal(await service.detect({ projectId: owner.projectId }), false)
    assert.equal(await service.detect(owner), true)
  })
  it('stops the previous app session before rerunning the same selection', async () => {
    const { service, driver } = fixture()
    await service.discover(owner)
    const first = await service.execute(owner, selection, 'run')
    await tick()
    driver.finish?.()
    await tick()
    const second = await service.execute(owner, selection, 'run')
    await tick()
    assert.deepEqual(driver.stopped, ['session'])
    assert.equal(
      (await service.operations(owner)).find((op) => op.id === first.id)?.stage,
      'stopped',
    )
    await service.cancel(owner, second.id)
    await tick()
  })
  it('runs the resolved thread checkout with live stages, remembers choices, and presents only after launch', async () => {
    const { service, driver, presented } = fixture()
    await service.discover(owner)
    const operation = await service.execute(owner, selection, 'run')
    await tick()
    assert.equal(driver.root, '/work/thread')
    assert.equal((await service.operations(owner))[0]?.stage, 'building')
    assert.match((await service.operations(owner))[0]?.logs ?? '', /Compiling/)
    assert.deepEqual(presented, [])
    driver.finish?.()
    await tick()
    assert.equal((await service.operations(owner))[0]?.stage, 'running')
    assert.deepEqual(presented, [{ id: 'android:123', owner }])
    assert.equal((await service.discover(owner)).preferred?.appId, selection.appId)
    await service.stop(owner, operation.id)
    assert.deepEqual(driver.stopped, ['session'])
    assert.equal((await service.operations(owner))[0]?.stage, 'stopped')
  })
  it('rejects stale checkout/app/device selections before execution', async () => {
    const { service, driver, changeRoot } = fixture()
    await service.discover(owner)
    await assert.rejects(
      service.execute(owner, { ...selection, variant: 'Other' }, 'run'),
      /variant/,
    )
    await assert.rejects(
      service.execute(owner, { ...selection, deviceId: 'unknown' }, 'run'),
      /device/,
    )
    changeRoot()
    await assert.rejects(service.execute(owner, selection, 'run'), /checkout or app changed/)
    assert.equal(driver.root, '')
  })
  it('isolates operation access, cancels its process, and prevents overlapping builds', async () => {
    const { service, driver, presented } = fixture()
    await service.discover(owner)
    const operation = await service.execute(owner, selection, 'run')
    await tick()
    await assert.rejects(service.execute(owner, selection, 'build'), /already running/)
    const other = { projectId: owner.projectId, threadId: 'other' }
    assert.deepEqual(await service.operations(other), [])
    await assert.rejects(service.cancel(other, operation.id), /belongs/)
    await assert.rejects(service.stop(other, operation.id), /belongs/)
    await service.cancel(owner, operation.id)
    await tick()
    assert.equal(driver.aborted, true)
    assert.equal((await service.operations(owner))[0]?.stage, 'cancelled')
    assert.deepEqual(presented, [])
  })
  it('never replays a persisted operation after a restart', async () => {
    const { service, driver } = fixture()
    await service.discover(owner)
    await service.execute(owner, selection, 'run')
    await tick()
    const stored = (await service.operations(owner))[0]
    assert.ok(stored)
    storageSet('app-run.state', { preferences: {}, operations: [{ ...stored, stage: 'building' }] })
    const fresh = new AppRunService({
      drivers: { android: driver, apple: driver },
      resolveRoot: async (): Promise<string> => '/work/thread',
    })
    services.push(fresh)
    const recovered = (await fresh.operations(owner))[0]
    assert.equal(recovered?.stage, 'failed')
    assert.match(recovered.error ?? '', /restarted/)
  })
})
