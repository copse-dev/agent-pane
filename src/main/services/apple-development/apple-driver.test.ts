import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  appleBuildPathArguments,
  appleOperationPaths,
  discoverAppleCandidates,
  discoverSharedSchemes,
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
