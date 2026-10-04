import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSetting, setSetting, updateSetting } from '../storage/settings.ts'
import { SETTINGS_WRITE_QUEUE, runSerialized } from '../storage/write-queue.ts'
import { addTrustedShellCommand } from './command-routing-config.ts'

const SETTING = 'trustedShellCommands'

describe('trusted command settings', () => {
  it('keeps both commands when two grants overlap', async () => {
    await setSetting(SETTING, [])

    await Promise.all([addTrustedShellCommand('curl'), addTrustedShellCommand('xcodebuild')])

    assert.deepEqual(getSetting<string[]>(SETTING, []), ['curl', 'xcodebuild'])
  })

  it('reads after preceding writers in the shared settings transaction queue', async () => {
    // An earlier ordinary batch or mutation must land before a grant reads its value.
    await setSetting(SETTING, [])

    const { promise: blocked, resolve: release } = Promise.withResolvers<undefined>()
    const blocker = runSerialized(SETTINGS_WRITE_QUEUE, () => blocked)
    const earlierWrite = updateSetting<string[]>(SETTING, [], () => ['git'])

    let settled = false
    const remember = addTrustedShellCommand('curl').then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      assert.equal(settled, false, 'the grant must wait behind the queued settings write')
    } finally {
      release(undefined)
      await Promise.all([blocker, earlierWrite, remember])
    }
    assert.deepEqual(getSetting<string[]>(SETTING, []), ['git', 'curl'])
  })

  it('is a no-op for a duplicate or malformed entry', async () => {
    await setSetting(SETTING, ['curl'])

    await addTrustedShellCommand('curl')
    await addTrustedShellCommand('not a command')

    assert.deepEqual(getSetting<string[]>(SETTING, []), ['curl'])
  })
})
