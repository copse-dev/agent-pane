import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { readOnlyProfileStoreFactory, readProfileStores } from './read-only-profile-store.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('readOnlyProfileStoreFactory', () => {
  it('reads the profile and keeps every write in memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ro-store-'))
    dirs.push(dir)
    const original = JSON.stringify({ projects: [{ id: 'p1' }], model: 'a' })
    writeFileSync(join(dir, 'config.json'), original)
    const writes: string[] = []
    const store = readOnlyProfileStoreFactory(await readProfileStores(dir), (name, key) =>
      writes.push(`${name}:${key}`),
    )({})
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

  it('reads and writes dotted paths into nested objects, as electron-store does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ro-store-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ apiKey: { anthropic: { v: 1, enc: 'sealed' } }, model: 'a' }),
    )
    const store = readOnlyProfileStoreFactory(await readProfileStores(dir))({ name: 'settings' })
    assert.deepEqual(store.get('apiKey.anthropic'), { v: 1, enc: 'sealed' })
    assert.equal(store.get('apiKey.openai'), undefined)
    assert.equal(store.get('model.nested'), undefined)
    store.set('apiKey.openai', { v: 1, enc: 'other' })
    assert.deepEqual(store.get('apiKey'), {
      anthropic: { v: 1, enc: 'sealed' },
      openai: { v: 1, enc: 'other' },
    })
    store.delete('apiKey.anthropic')
    assert.deepEqual(store.get('apiKey'), { openai: { v: 1, enc: 'other' } })
    store.set('fresh.deep.key', 1)
    assert.equal(store.get('fresh.deep.key'), 1)
    assert.deepEqual(store.listKeys().sort(), ['apiKey', 'fresh', 'model'])
  })

  it('treats a missing or unreadable store as empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ro-store-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'broken.json'), '{')
    const factory = readOnlyProfileStoreFactory(await readProfileStores(dir))
    assert.deepEqual(factory({ name: 'broken' }).listKeys(), [])
    assert.deepEqual(factory({ name: 'absent' }).listKeys(), [])
  })

  it('reports every change with its value, and reloads open stores in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ro-profile-change-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', model: 'a' }))
    const changes: unknown[] = []
    const factory = readOnlyProfileStoreFactory(
      await readProfileStores(dir),
      undefined,
      (store, change) => changes.push([store, change]),
    )
    const settings = factory({ name: 'settings' })
    settings.set('model', 'b')
    settings.setMany?.({ a: 1, b: 2 })
    settings.delete('theme')
    settings.deleteKeys(['a'])
    assert.deepEqual(changes, [
      ['settings', [{ key: 'model', value: 'b' }]],
      [
        'settings',
        [
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ],
      ],
      ['settings', [{ key: 'theme', deleted: true }]],
      ['settings', [{ key: 'a', deleted: true }]],
    ])

    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'light' }))
    factory.reload(await readProfileStores(dir))
    assert.deepEqual(settings.listKeys(), ['theme'])
    assert.equal(settings.get('theme'), 'light')
  })
})
