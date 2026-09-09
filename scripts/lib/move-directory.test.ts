import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { moveDirectory, type DirectoryMoveOperations } from './move-directory.mts'

function crossDeviceError(): Error & { code: string } {
  return Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
}

describe('moveDirectory', () => {
  it('uses a direct rename when source and target share a filesystem', () => {
    const calls: string[] = []
    const operations: DirectoryMoveOperations = {
      rename: (source, target) => {
        calls.push(`rename ${source} ${target}`)
      },
      copy: () => assert.fail('copy should not run'),
      remove: () => assert.fail('remove should not run'),
      stagingPath: () => assert.fail('staging path should not be needed'),
    }

    assert.equal(moveDirectory('/source', '/cache/dist', operations), 'moved')
    assert.deepEqual(calls, ['rename /source /cache/dist'])
  })

  it('copies through destination-side staging after EXDEV', () => {
    const calls: string[] = []
    let renameAttempt = 0
    const operations: DirectoryMoveOperations = {
      rename: (source, target) => {
        calls.push(`rename ${source} ${target}`)
        renameAttempt += 1
        if (renameAttempt === 1) throw crossDeviceError()
      },
      copy: (source, target) => {
        calls.push(`copy ${source} ${target}`)
      },
      remove: (path) => {
        calls.push(`remove ${path}`)
      },
      stagingPath: () => '/cache/.dist-copy',
    }

    assert.equal(moveDirectory('/source', '/cache/dist', operations), 'copied')
    assert.deepEqual(calls, [
      'rename /source /cache/dist',
      'copy /source /cache/.dist-copy',
      'rename /cache/.dist-copy /cache/dist',
      'remove /source',
      'remove /cache/.dist-copy',
    ])
  })

  it('keeps the source and cleans staging when the copy fails', () => {
    const removed: string[] = []
    const operations: DirectoryMoveOperations = {
      rename: () => {
        throw crossDeviceError()
      },
      copy: () => {
        throw new Error('disk full')
      },
      remove: (path) => {
        removed.push(path)
      },
      stagingPath: () => '/cache/.dist-copy',
    }

    assert.throws(() => moveDirectory('/source', '/cache/dist', operations), /disk full/)
    assert.deepEqual(removed, ['/cache/.dist-copy'])
  })

  it('does not hide a rename failure unrelated to filesystem boundaries', () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const operations: DirectoryMoveOperations = {
      rename: () => {
        throw denied
      },
      copy: () => assert.fail('copy should not run'),
      remove: () => assert.fail('remove should not run'),
      stagingPath: () => assert.fail('staging path should not be needed'),
    }

    assert.throws(() => moveDirectory('/source', '/cache/dist', operations), denied)
  })
})
