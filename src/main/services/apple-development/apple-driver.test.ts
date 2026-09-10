import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  appleBuildPathArguments,
  appleOperationPaths,
  discoverAppleCandidates,
  discoverMissingLocalPackages,
  discoverSharedSchemes,
  xcodeFailureDetail,
} from './apple-driver.ts'

describe('appleOperationPaths', () => {
  it('isolates build products per operation and package caches per checkout', () => {
    const first = appleOperationPaths('/workspace/one', 'operation-1')
    const retried = appleOperationPaths('/workspace/one', 'operation-1')
    const next = appleOperationPaths('/workspace/one', 'operation-2')
    const otherCheckout = appleOperationPaths('/workspace/two', 'operation-1')

    assert.deepEqual(retried, first)
    assert.notEqual(next.outputRoot, first.outputRoot)
    assert.equal(next.clonedSourcePackagesPath, first.clonedSourcePackagesPath)
    assert.equal(next.packageCachePath, first.packageCachePath)
    assert.notEqual(otherCheckout.clonedSourcePackagesPath, first.clonedSourcePackagesPath)
    assert.deepEqual(appleBuildPathArguments(first), [
      '-derivedDataPath',
      first.derivedDataPath,
      '-clonedSourcePackagesDirPath',
      first.clonedSourcePackagesPath,
      '-packageCachePath',
      first.packageCachePath,
    ])
  })
})

describe('xcodeFailureDetail', () => {
  it('prefers the actionable denied path over SwiftPM permission tokens', () => {
    assert.equal(
      xcodeFailureDetail(
        [
          'failed loading cached manifest: Unable to open database at path /scratch/manifest.db: authorization denied',
          'xcodebuild: error: Could not resolve package dependencies:',
          '  error: permissionDenied',
        ].join('\n'),
      ),
      'failed loading cached manifest: Unable to open database at path /scratch/manifest.db: authorization denied',
    )
  })

  it('names the denied Xcode path instead of rendering a nested NSError token', () => {
    assert.equal(
      xcodeFailureDetail(
        [
          '[MT] IDELogStore: Failed to open Build log store: Error Domain=NSCocoaErrorDomain Code=513',
          'NSURL = "file:///Users/me/.copse/workspace/tmp/apple-development/DerivedData/Logs/Build/LogStoreManifest.plist";',
          'NSUnderlyingError = "Error Domain=NSPOSIXErrorDomain Code=1 \\"Operation not permitted\\"";',
        ].join('\n'),
      ),
      'Xcode could not access /Users/me/.copse/workspace/tmp/apple-development/DerivedData/Logs/Build/LogStoreManifest.plist: Operation not permitted.',
    )
  })

  it('surfaces a concrete signing error instead of the generic build footer', () => {
    assert.equal(
      xcodeFailureDetail(
        [
          '/checkout/Browser.xcodeproj: error: No profiles for com.example.browser.debug were found: Xcode could not find any macOS App Development provisioning profiles matching com.example.browser.debug.',
          '** BUILD FAILED **',
          'The following build commands failed:',
        ].join('\n'),
      ),
      '/checkout/Browser.xcodeproj: error: No profiles for com.example.browser.debug were found: Xcode could not find any macOS App Development provisioning profiles matching com.example.browser.debug.',
    )
  })
})

describe('discoverAppleCandidates', () => {
  it('finds bounded nested projects while skipping dependencies and symlinks', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'copse-apple-driver-'))
    const root = join(parent, 'checkout')
    const external = join(parent, 'external', 'Linked.xcodeproj')
    try {
      await Promise.all([
        mkdir(join(root, 'Root.xcodeproj'), { recursive: true }),
        mkdir(join(root, 'ios', 'DemoApp.xcworkspace'), { recursive: true }),
        mkdir(join(root, 'apps', 'Mac', 'DemoApp.xcodeproj'), { recursive: true }),
        mkdir(join(root, 'node_modules', 'Ignored.xcodeproj'), { recursive: true }),
        mkdir(join(root, 'Pods', 'Ignored.xcworkspace'), { recursive: true }),
        mkdir(join(root, '.generated', 'Ignored.xcodeproj'), { recursive: true }),
        mkdir(external, { recursive: true }),
      ])
      await symlink(external, join(root, 'Linked.xcodeproj'), 'dir')

      assert.deepEqual(await discoverAppleCandidates(root), [
        {
          id: 'ios/DemoApp.xcworkspace',
          name: 'ios/DemoApp',
          kind: 'workspace',
          schemes: [],
        },
        {
          id: 'apps/Mac/DemoApp.xcodeproj',
          name: 'apps/Mac/DemoApp',
          kind: 'project',
          schemes: [],
        },
        {
          id: 'Root.xcodeproj',
          name: 'Root',
          kind: 'project',
          schemes: [],
        },
      ])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('reports missing local Swift packages before launching Xcode', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'copse-apple-local-packages-'))
    const root = join(parent, 'checkout')
    const project = join(root, 'apps', 'Browser.xcodeproj')
    try {
      await mkdir(project, { recursive: true })
      await writeFile(
        join(project, 'project.pbxproj'),
        [
          'A1 = {',
          '  isa = XCLocalSwiftPackageReference;',
          '  relativePath = LocalPackages/AppUpdater;',
          '};',
          'A2 = {',
          '  isa = XCLocalSwiftPackageReference;',
          '  relativePath = "LocalPackages/Existing Package";',
          '};',
        ].join('\n'),
      )
      await mkdir(join(root, 'apps', 'LocalPackages', 'Existing Package'), { recursive: true })
      await mkdir(join(parent, 'ExternalPackage'), { recursive: true })
      const projectText = await readFile(join(project, 'project.pbxproj'), 'utf8')
      await writeFile(
        join(project, 'project.pbxproj'),
        [
          projectText,
          'A3 = {',
          '  isa = XCLocalSwiftPackageReference;',
          '  relativePath = ../../ExternalPackage;',
          '};',
        ].join('\n'),
      )

      assert.deepEqual(await discoverMissingLocalPackages(root, 'apps/Browser.xcodeproj'), [
        'LocalPackages/AppUpdater',
      ])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('reads shared schemes without invoking Xcode metadata discovery', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'copse-apple-schemes-'))
    const root = join(parent, 'checkout')
    const project = join(root, 'apps', 'Browser.xcodeproj')
    try {
      await Promise.all([
        mkdir(join(project, 'xcshareddata', 'xcschemes'), { recursive: true }),
        mkdir(join(project, 'xcuserdata', 'private.xcuserdatad', 'xcschemes'), {
          recursive: true,
        }),
      ])
      await Promise.all([
        writeFile(join(project, 'xcshareddata', 'xcschemes', 'Browser.xcscheme'), ''),
        writeFile(join(project, 'xcshareddata', 'xcschemes', 'Browser Tests.xcscheme'), ''),
        writeFile(
          join(project, 'xcuserdata', 'private.xcuserdatad', 'xcschemes', 'Private.xcscheme'),
          '',
        ),
      ])

      assert.deepEqual(
        await discoverSharedSchemes(root, {
          id: 'apps/Browser.xcodeproj',
          name: 'apps/Browser',
          kind: 'project',
          schemes: [],
        }),
        ['Browser', 'Browser Tests'],
      )
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
