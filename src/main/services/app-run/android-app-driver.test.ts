import type { AndroidEndpoint } from '../android-desktop/android-discovery.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AndroidAppDriver,
  androidAppDriverInternals,
  type AndroidToolchain,
} from './android-app-driver.ts'
import type { AppRunStage } from '@shared/types/app-run.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(
  minimumSdk = 1,
): Promise<{ root: string; driver: AndroidAppDriver; calls: string[][]; stages: AppRunStage[] }> {
  const root = await mkdtemp(join(tmpdir(), 'copse-app-run-'))
  roots.push(root)
  const moduleDirectory = join(root, 'app')
  const buildDirectory = join(moduleDirectory, 'build')
  const output = join(buildDirectory, 'outputs/apk/demo/debug')
  await mkdir(output, { recursive: true })
  await writeFile(join(root, 'gradlew'), '#!/bin/sh\n')
  await writeFile(join(root, 'emulator'), '')
  await writeFile(join(output, 'app.apk'), 'test apk')
  await writeFile(
    join(output, 'output-metadata.json'),
    JSON.stringify({
      applicationId: 'dev.copse.demo',
      variantName: 'demoDebug',
      elements: [{ outputFile: 'app.apk', filters: [] }],
    }),
  )
  const calls: string[][] = []
  const stages: AppRunStage[] = []
  const driver = new AndroidAppDriver({
    wrappers: async (): Promise<string[]> => [join(root, 'gradlew')],
    tools: async (): Promise<AndroidToolchain> => ({
      sdk: root,
      adb: 'adb',
      emulator: join(root, 'emulator'),
      javaHome: undefined,
      avdmanager: null,
      sdkmanager: null,
    }),
    endpoints: async (): Promise<AndroidEndpoint[]> => [
      {
        avdId: 'TestPhone',
        port: 8554,
        token: 'private',
        device: { udid: 'android:123', platform: 'android', name: 'TestPhone', runtime: 'Android' },
      },
    ],
    run: async (file, args): Promise<string> => {
      calls.push([file, ...args])
      if (args.includes('copseDescribeApplications'))
        return (
          'COPSE_ANDROID_APPS=' +
          JSON.stringify([
            {
              path: ':app',
              name: 'Sample',
              directory: moduleDirectory,
              buildDirectory,
              variants: ['DemoDebug'],
              minimumSdks: { demodebug: minimumSdk },
            },
          ])
        )
      if (args.includes('-list-avds')) return 'TestPhone\n'
      if (args[0] === 'devices') return 'emulator-5554\tdevice\n'
      if (args.includes('avd')) return 'TestPhone\nOK\n'
      if (args.includes('getprop')) return '1\n'
      if (args.includes('resolve-activity')) return 'dev.copse.demo/.MainActivity\n'
      if (args.includes('start')) return 'Status: ok\nActivity: dev.copse.demo/.MainActivity\n'
      return ''
    },
  })
  return { root, driver, calls, stages }
}
describe('Android app driver', () => {
  it('keeps image downloads separate from device creation and never accepts licenses implicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-app-setup-'))
    roots.push(root)
    const image = `system-images;android-34;google_apis;${process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}`
    const calls: { args: readonly string[]; input: string | undefined }[] = []
    const driver = new AndroidAppDriver({
      tools: async (): Promise<AndroidToolchain> => ({
        sdk: root,
        adb: 'adb',
        emulator: 'emulator',
        javaHome: undefined,
        sdkmanager: 'sdkmanager',
        avdmanager: 'avdmanager',
      }),
      run: async (_file, args, _root, _signal, options): Promise<string> => {
        calls.push({ args, input: options?.input })
        if (args.includes('--list')) return image
        if (args[0] === 'list') return 'pixel\n'
        if (args[0] === image) {
          const directory = join(root, ...image.split(';'))
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'source.properties'), '')
        }
        return ''
      },
    })
    const signal = new AbortController().signal
    const progress = { stage: (): void => {}, log: (): void => {} }
    const input = {
      platform: 'android' as const,
      action: 'create-device' as const,
      runtimeId: image,
      deviceTypeId: 'pixel',
      name: 'Test phone',
    }
    await assert.rejects(driver.setup(root, input, progress, signal), /installed image/)
    assert.ok(!calls.some((call) => call.args[0] === image || call.args[0] === 'create'))
    await driver.setup(root, { ...input, action: 'install-android-image' }, progress, signal)
    assert.equal(calls.find((call) => call.args[0] === image)?.input, undefined)
    await driver.setup(root, input, progress, signal)
    const create = calls.find((call) => call.args[0] === 'create')
    assert.ok(create)
    assert.ok(create.args.includes('Copse_Test_phone'))
    assert.ok(!create.args.includes('--force'))
  })
  it('marks an installed AVD unavailable when its runtime is older than the selected variant', async () => {
    const { root, driver } = await fixture(34)
    const previous = process.env['ANDROID_AVD_HOME']
    process.env['ANDROID_AVD_HOME'] = root
    try {
      await mkdir(join(root, 'TestPhone.avd'))
      await writeFile(
        join(root, 'TestPhone.avd/config.ini'),
        'image.sysdir.1=system-images/android-33/google_apis/arm64-v8a/\n',
      )
      const signal = new AbortController().signal
      const app = (await driver.discover(root, signal)).apps[0]
      assert.ok(app)
      const device = (await driver.devices(root, app, signal, 'DemoDebug'))[0]
      assert.equal(device?.state, 'unavailable')
      assert.match(device.detail ?? '', /API 34/)
      await assert.rejects(
        driver.execute(
          root,
          app,
          {
            appId: app.id,
            deviceId: 'android-avd:TestPhone',
            variant: 'DemoDebug',
            configuration: 'Debug',
            provisioningUpdates: false,
          },
          'run',
          'op',
          { stage: () => {}, log: () => {} },
          signal,
        ),
        /emulator is no longer available/i,
      )
    } finally {
      if (previous === undefined) delete process.env['ANDROID_AVD_HOME']
      else process.env['ANDROID_AVD_HOME'] = previous
    }
  })
  it('discovers actual modules/variants and builds, installs, launches, then stops on one serial', async () => {
    const { root, driver, calls, stages } = await fixture()
    const signal = new AbortController().signal
    const discovery = await driver.discover(root, signal)
    const app = discovery.apps[0]
    assert.ok(app)
    assert.deepEqual(app.variants, ['DemoDebug'])
    const result = await driver.execute(
      root,
      app,
      {
        appId: app.id,
        deviceId: 'android-avd:TestPhone',
        variant: 'DemoDebug',
        configuration: 'Debug',
        provisioningUpdates: false,
      },
      'run',
      'op',
      { stage: (s) => stages.push(s), log: () => {} },
      signal,
    )
    assert.deepEqual(stages, ['building', 'starting-device', 'installing', 'launching'])
    assert.equal(result.desktopId, 'android:123')
    assert.ok(calls.some((args) => args.includes(':app:assembleDemoDebug')))
    assert.ok(calls.some((args) => args.includes('install') && args.includes('emulator-5554')))
    assert.ok(result.appSessionId)
    await driver.stop(root, result.appSessionId, signal)
    assert.ok(calls.some((args) => args.includes('force-stop') && args.at(-1) === 'dev.copse.demo'))
  })
  it('build and local unit tests do not start a device or install an app', async () => {
    const { root, driver, calls } = await fixture()
    const signal = new AbortController().signal
    const app = (await driver.discover(root, signal)).apps[0]
    assert.ok(app)
    calls.length = 0
    const selection = {
      appId: app.id,
      deviceId: '',
      variant: 'DemoDebug',
      configuration: 'Debug',
      provisioningUpdates: false,
    }
    await driver.execute(
      root,
      app,
      selection,
      'build',
      'build',
      { stage: () => {}, log: () => {} },
      signal,
    )
    await driver.execute(
      root,
      app,
      selection,
      'test',
      'test',
      { stage: () => {}, log: () => {} },
      signal,
    )
    assert.equal(calls.length, 2)
    assert.ok(calls[1]?.includes(':app:testDemoDebugUnitTest'))
  })
  it('detects nested wrappers without descending into dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-app-detect-'))
    roots.push(root)
    await mkdir(join(root, 'android'), { recursive: true })
    await writeFile(join(root, 'android/gradlew'), '')
    await mkdir(join(root, 'node_modules/fake'), { recursive: true })
    await writeFile(join(root, 'node_modules/fake/gradlew'), '')
    assert.deepEqual(await androidAppDriverInternals.findWrappers(root), [
      join(root, 'android/gradlew'),
    ])
  })
})
