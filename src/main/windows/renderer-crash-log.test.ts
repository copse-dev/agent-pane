import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  CRASH_LOG_FILE,
  CRASH_LOG_MAX_ENTRIES,
  appendRendererCrash,
  readRendererCrashes,
  rendererCrashLogPath,
  type RendererCrashRecord,
} from './renderer-crash-log.ts'

let dir = ''
let path = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copse-crash-log-'))
  path = join(dir, 'user-data', CRASH_LOG_FILE)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function crash(at: number): RendererCrashRecord {
  return {
    at,
    window: 'main',
    reason: 'crashed',
    exitCode: 5,
    context: 'lastLargeIpc=threads:create estimated<=612MB ago=1200ms',
    action: 'reloaded',
  }
}

describe('renderer crash log', () => {
  it('lives in the profile user-data directory', () => {
    assert.equal(rendererCrashLogPath({ COPSE_DIR: '/p' }), join('/p', 'user-data', CRASH_LOG_FILE))
  })

  it('appends records and reads back those since a time, oldest first', async () => {
    // Not awaited one by one: appends queue, so concurrent crashes keep their order.
    void appendRendererCrash(crash(1_000), path)
    void appendRendererCrash(crash(2_000), path)
    await appendRendererCrash(crash(3_000), path)
    assert.deepEqual(await readRendererCrashes(2_000, path), [crash(2_000), crash(3_000)])
  })

  it('keeps only the newest records', async () => {
    for (let i = 1; i <= CRASH_LOG_MAX_ENTRIES + 5; i++) await appendRendererCrash(crash(i), path)
    const records = await readRendererCrashes(0, path)
    assert.equal(records.length, CRASH_LOG_MAX_ENTRIES)
    assert.equal(records[0]?.at, 6)
    assert.equal(records.at(-1)?.at, CRASH_LOG_MAX_ENTRIES + 5)
  })

  it('reads a missing file as no crashes and skips lines it cannot parse', async () => {
    assert.deepEqual(await readRendererCrashes(0, path), [])
    await appendRendererCrash(crash(1_000), path)
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json\n{"at":"x"}\n`)
    assert.deepEqual(await readRendererCrashes(0, path), [crash(1_000)])
  })

  it('skips a record whose time a Date cannot hold', async () => {
    await appendRendererCrash(crash(1_000), path)
    const outOfRange = JSON.stringify({ ...crash(1_000), at: 1e300 })
    writeFileSync(path, `${readFileSync(path, 'utf8')}${outOfRange}\n`)
    assert.deepEqual(await readRendererCrashes(0, path), [crash(1_000)])
  })

  it('never rejects when the record cannot be written', async () => {
    const warn = mock.method(console, 'warn', () => undefined)
    try {
      // A directory where the file should be.
      await appendRendererCrash(crash(1_000), dir)
    } finally {
      warn.mock.restore()
    }
    assert.equal(warn.mock.callCount(), 1)
  })
})
