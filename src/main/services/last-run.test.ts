import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { previousRunAllowsResume, readLastRun, RunRecorder } from './last-run.ts'

const dirs: string[] = []
function recordPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copse-last-run-'))
  dirs.push(dir)
  return join(dir, 'last-run.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RunRecorder', () => {
  it('reads the previous run, then records this start', async () => {
    const path = recordPath()
    writeFileSync(path, JSON.stringify({ startedAt: 10, ended: 'update' }))
    const recorder = new RunRecorder(path, 20)
    assert.deepEqual(await recorder.previous, { startedAt: 10, ended: 'update' })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { startedAt: 20 })
  })

  it('records a quit, or an update relaunch when the updater said so', async () => {
    const quit = recordPath()
    await new RunRecorder(quit, 5).end()
    assert.deepEqual(await readLastRun(quit), { startedAt: 5, ended: 'quit' })

    const update = recordPath()
    const updating = new RunRecorder(update, 6)
    updating.noteUpdateRelaunch()
    await updating.end()
    assert.deepEqual(await readLastRun(update), { startedAt: 6, ended: 'update' })
  })

  it('reads back a start time with a fraction of a millisecond', async () => {
    const path = recordPath()
    writeFileSync(path, JSON.stringify({ startedAt: 1795659222761.8193 }))
    assert.deepEqual(await readLastRun(path), { startedAt: 1795659222761.8193 })
  })

  it('treats a missing or unreadable record as no previous run', async () => {
    const path = recordPath()
    assert.equal(await new RunRecorder(path, 1).previous, null)
    writeFileSync(path, '{not json')
    assert.equal(await readLastRun(path), null)
  })
})

describe('previousRunAllowsResume', () => {
  it('continues after a crash or an update, not after a quit or with no record', () => {
    assert.equal(previousRunAllowsResume({ startedAt: 1 }), true)
    assert.equal(previousRunAllowsResume({ startedAt: 1, ended: 'update' }), true)
    assert.equal(previousRunAllowsResume({ startedAt: 1, ended: 'quit' }), false)
    assert.equal(previousRunAllowsResume(null), false)
  })
})
