import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { prepareElectronHeaders } from './electron-headers.mts'

test('offline Electron headers fail on an incomplete cache without invoking an installer', () => {
  const cache = mkdtempSync(join(tmpdir(), 'copse-headers-'))
  const options = { cache, version: '44.1.1', nodeGypCli: '/must-not-run', offline: true }
  try {
    assert.throws(() => prepareElectronHeaders(options), /Offline build needs Electron/)
    for (const file of ['installVersion', 'include/node/node.h', 'include/node/common.gypi']) {
      const path = join(cache, options.version, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'fixture')
    }
    assert.throws(() => prepareElectronHeaders(options), /Offline build needs Electron/)
    writeFileSync(join(cache, options.version, 'include/node/config.gypi'), 'fixture')
    assert.equal(prepareElectronHeaders(options), join(cache, options.version))
    assert.throws(
      () => prepareElectronHeaders({ ...options, version: '../escape' }),
      /Invalid installed Electron/,
    )
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})
