import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AppleAppDriver } from './apple-app-driver.ts'
import {
  InstalledXcodeDriver,
  type AppleDriverDiscovery,
  type AppleDriverPlan,
  type AppleDriverResult,
  appleBuildActionArguments,
} from '../apple-development/apple-driver.ts'
import type { AppleDestination } from '@shared/types/apple-development.ts'
import type { AppRunSelection } from '@shared/types/app-run.ts'
class Xcode extends InstalledXcodeDriver {
  plan: AppleDriverPlan | undefined
  override discover(): Promise<AppleDriverDiscovery> {
    return Promise.resolve({
      toolchain: { developerDir: '/Xcode', version: 'Xcode' },
      candidates: [{ id: 'App.xcodeproj', kind: 'project', name: 'App', schemes: ['App'] }],
      destinations: [],
      metadataRequiresExecution: false,
      setupMessage: null,
    })
  }
  override destinations(): Promise<AppleDestination[]> {
    return Promise.resolve([
      {
        id: 'platform=iOS Simulator,id=sim',
        name: 'iPhone',
        platform: 'iOS Simulator',
        supported: true,
        booted: false,
      },
    ])
  }
  override execute(plan: AppleDriverPlan): Promise<AppleDriverResult> {
    this.plan = plan
    plan.progress?.stage('building')
    return Promise.resolve({
      exitCode: 0,
      logs: 'Built',
      outputTruncated: false,
      diagnostics: [],
      testSummary: null,
      appSession: { id: 'session' },
    })
  }
}
describe('Apple shared Run adapter', () => {
  it('reuses Xcode execution with the chosen scheme, destination, and explicit signing decision', async () => {
    const xcode = new Xcode()
    const driver = new AppleAppDriver(xcode, 'darwin')
    const signal = new AbortController().signal
    const discovery = await driver.discover('/project', signal)
    const app = discovery.apps[0]
    assert.ok(app)
    const selection: AppRunSelection = {
      appId: app.id,
      deviceId: 'platform=iOS Simulator,id=sim',
      variant: 'App',
      configuration: 'Debug',
      provisioningUpdates: false,
    }
    const result = await driver.execute(
      '/project',
      app,
      selection,
      'run',
      'operation',
      { stage: () => {}, log: () => {} },
      signal,
    )
    assert.equal(xcode.plan?.provisioningUpdates, false)
    assert.equal(xcode.plan.target.schemeId, 'App')
    assert.equal(xcode.plan.target.destinationId, selection.deviceId)
    assert.equal(result.desktopId, 'sim')
    assert.equal(result.appSessionId, 'session')
    await driver.execute(
      '/project',
      app,
      { ...selection, provisioningUpdates: true },
      'build',
      'next',
      { stage: () => {}, log: () => {} },
      signal,
    )
    assert.equal(xcode.plan.provisioningUpdates, true)
  })
  it('preserves legacy provisioning while allowing the shared picker to leave it disabled', () => {
    const paths = {
      outputRoot: '/tmp/result',
      derivedDataPath: '/tmp/derived',
      clonedSourcePackagesPath: '/tmp/sources',
      packageCachePath: '/tmp/cache',
    }
    assert.ok(appleBuildActionArguments(paths).includes('-allowProvisioningUpdates'))
    assert.ok(!appleBuildActionArguments(paths, false).includes('-allowProvisioningUpdates'))
  })
})
