import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSetting, setSetting } from '../storage/settings.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { addTrustedShellCommand } from './command-routing-config.ts'

const SETTING = 'trustedShellCommands'

describe('trusted command settings', () => {
  it('keeps both commands when two grants overlap', async () => {
    await setSetting(SETTING, [])

    await Promise.all([addTrustedShellCommand('curl'), addTrustedShellCommand('xcodebuild')])

    assert.deepEqual(getSetting<string[]>(SETTING, []), ['curl', 'xcodebuild'])
  })

  it('reads inside the settings queue for its own key, not a private one', async () => {
    // The lost update this guards against is a read taken before some *other*
    // writer of the same key has landed. A queue of its own cannot see that
    // writer, so the mutation has to sit on `settings:<key>` like every other
    // write to it.
    await setSetting(SETTING, [])

    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    void runSerialized(`settings:${SETTING}`, () => blocked)

    let settled = false
    const remember = addTrustedShellCommand('curl').then(() => {
      settled = true
    })
    for (let i = 0; i < 15; i++) await new Promise((resolve) => setTimeout(resolve, 1))

    assert.equal(settled, false, 'the grant must wait behind the queued settings write')

    release()
    await remember
    assert.deepEqual(getSetting<string[]>(SETTING, []), ['curl'])
  })

  it('is a no-op for a duplicate or malformed entry', async () => {
    await setSetting(SETTING, ['curl'])

    await addTrustedShellCommand('curl')
    await addTrustedShellCommand('not a command')

    assert.deepEqual(getSetting<string[]>(SETTING, []), ['curl'])
  })
})
