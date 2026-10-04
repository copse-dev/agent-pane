import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, utimes, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageDelete, storageSet } from './storage/storage.ts'
import {
  expireStorageData,
  readStorageRetention,
  saveStorageRetention,
} from './storage-maintenance.ts'

const originalProfile = process.env['COPSE_DIR']
const originalWorkspace = process.env['COPSE_WORKSPACE_DIR']
afterEach(() => {
  storageDelete('storageRetention')
  if (originalProfile === undefined) delete process.env['COPSE_DIR']
  else process.env['COPSE_DIR'] = originalProfile
  if (originalWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
  else process.env['COPSE_WORKSPACE_DIR'] = originalWorkspace
})
test('retention defaults safely and rejects malformed policy', () => {
  storageDelete('storageRetention')
  assert.deepEqual(readStorageRetention(), { enabled: true, days: 30 })
  storageSet('storageRetention', { enabled: true, days: -1 })
  assert.deepEqual(readStorageRetention(), { enabled: false, days: 30 })
  assert.throws(() => {
    saveStorageRetention({ enabled: true, days: 0 })
  })
  saveStorageRetention({ enabled: false, days: 90 })
  assert.deepEqual(readStorageRetention(), { enabled: false, days: 90 })
})
test('automatic expiry obeys disabled policy and configured profile roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copse-expiry-'))
  process.env['COPSE_DIR'] = root
  process.env['COPSE_WORKSPACE_DIR'] = join(root, 'custom-workspace')
  const build = join(root, 'custom-workspace/tmp/apple-development/old')
  try {
    await mkdir(build, { recursive: true })
    const file = join(build, 'cache')
    await writeFile(file, 'cache')
    const old = new Date(Date.now() - 40 * 86_400_000)
    await utimes(file, old, old)
    await utimes(build, old, old)
    saveStorageRetention({ enabled: false, days: 30 })
    await expireStorageData()
    await access(build)
    saveStorageRetention({ enabled: true, days: 30 })
    await expireStorageData()
    await assert.rejects(access(build), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
