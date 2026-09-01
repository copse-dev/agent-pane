import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rememberPermissionValue } from './permission-memory.ts'

describe('rememberPermissionValue', () => {
  it('keeps concurrent grants while an earlier write is pending', async () => {
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
      read: (): readonly string[] => stored,
      write: async (values: readonly string[]): Promise<void> => {
        writeCount += 1
        if (writeCount === 1) {
          markFirstWriteStarted?.()
          await firstWriteReleased
        }
        stored = values
      },
    }

    const rememberFirst = rememberPermissionValue('allowed-origins', 'https://first.test', store)
    await firstWriteStarted
    const rememberSecond = rememberPermissionValue('allowed-origins', 'https://second.test', store)
    releaseFirstWrite?.()
    await Promise.all([rememberFirst, rememberSecond])

    assert.deepEqual(stored, ['https://first.test', 'https://second.test'])
  })
})
