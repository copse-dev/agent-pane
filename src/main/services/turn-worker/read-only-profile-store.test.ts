import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { readOnlyProfileStoreFactory } from './read-only-profile-store.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('readOnlyProfileStoreFactory', () => {
  it('reads the profile and keeps every write in memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ro-store-'))
    dirs.push(dir)
    const original = JSON.stringify({ projects: [{ id: 'p1' }], model: 'a' })
    writeFileSync(join(dir, 'config.json'), original)
    const writes: string[] = []
    const store = readOnlyProfileStoreFactory(dir, (name, key) => writes.push(`${name}:${key}`))({})
    assert.deepEqual(store.get('projects'), [{ id: 'p1' }])
    store.set('model', 'b')
    store.set('model', 'c')
    store.setMany?.({ extra: 1 })
    store.deleteKeys(['projects'])
    assert.equal(store.get('model'), 'c')
    assert.equal(store.get('projects'), undefined)
    assert.deepEqual(store.listKeys().sort(), ['extra', 'model'])
    // The desktop's file is untouched, and each key is reported once.
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), original)
    assert.deepEqual(writes, ['config:model', 'config:extra', 'config:projects'])
  })

  it('treats a missing or unreadable store as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ro-store-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'broken.json'), '{')
    const factory = readOnlyProfileStoreFactory(dir)
    assert.deepEqual(factory({ name: 'broken' }).listKeys(), [])
    assert.deepEqual(factory({ name: 'absent' }).listKeys(), [])
  })
})
