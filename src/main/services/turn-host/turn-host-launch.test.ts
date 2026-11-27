import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getSetting } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { applyHostStoreWrite } from './turn-host-launch.ts'

describe('applyHostStoreWrite', () => {
  it("saves a host turn's config and settings writes, and never a key", async () => {
    const log: string[] = []
    storageSet('host-write-old', 1)
    applyHostStoreWrite(
      'config',
      [
        { key: 'host-write-new', value: { a: 1 } },
        { key: 'host-write-old', deleted: true },
        { key: 'apiKey.anthropic', value: 'sk-from-the-host' },
      ],
      (line) => log.push(line),
    )
    assert.deepEqual(storageGet('host-write-new'), { a: 1 })
    assert.equal(storageGet('host-write-old'), undefined)
    assert.equal(storageGet('apiKey'), undefined)

    applyHostStoreWrite('settings', [{ key: 'turnsRunInHost', value: true }], (line) =>
      log.push(line),
    )
    applyHostStoreWrite('ssh-credentials', [{ key: 'h', value: 'x' }], (line) => log.push(line))
    // Settings save through their write queue.
    await Promise.resolve()
    assert.equal(getSetting('turnsRunInHost', false), true)
    assert.equal(log.length, 2, log.join('\n'))
  })
})
