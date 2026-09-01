import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addTrustedShellCommand } from './command-routing-config.ts'

describe('trusted command settings', () => {
  it('keeps commands remembered while an earlier write is still pending', async () => {
    let stored: readonly string[] = []
    let releaseFirstWrite: (() => void) | undefined
    let markFirstWriteStarted: (() => void) | undefined
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve
    })
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let writeCount = 0
    const store = {
      read: (): unknown => stored,
      write: async (commands: readonly string[]): Promise<void> => {
        writeCount += 1
        if (writeCount === 1) {
          markFirstWriteStarted?.()
          await firstWriteReleased
        }
        stored = commands
      },
    }

    const rememberCurl = addTrustedShellCommand('curl', store)
    await firstWriteStarted
    const rememberXcodebuild = addTrustedShellCommand('xcodebuild', store)
    releaseFirstWrite?.()
    await Promise.all([rememberCurl, rememberXcodebuild])

    assert.deepEqual(stored, ['curl', 'xcodebuild'])
  })
})
