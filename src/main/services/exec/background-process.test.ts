import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectServerUrl,
  startBackgroundProcess,
  listBackgroundProcesses,
  getBackgroundProcessLogs,
  stopBackgroundProcess,
  stopAllBackgroundProcesses,
} from './background-process.ts'

describe('detectServerUrl', () => {
  it('reads a vite-style Local URL', () => {
    assert.equal(detectServerUrl('  ➜  Local:   http://localhost:5173/'), 'http://localhost:5173')
  })

  it('normalises 127.0.0.1 to localhost', () => {
    assert.equal(detectServerUrl('Listening at http://127.0.0.1:3000'), 'http://localhost:3000')
  })

  it('normalises a bind-all 0.0.0.0 URL to localhost', () => {
    assert.equal(
      detectServerUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)'),
      'http://localhost:8000',
    )
  })

  it('falls back to a bare "port NNNN" phrase', () => {
    assert.equal(detectServerUrl('Server listening on port 4321'), 'http://localhost:4321')
  })

  it('strips ANSI colour codes before matching', () => {
    assert.equal(detectServerUrl('\x1b[32mhttp://localhost:9000\x1b[0m'), 'http://localhost:9000')
  })

  it('returns null when no port is announced', () => {
    assert.equal(detectServerUrl('compiling...\ndone in 200ms'), null)
  })
})

describe('background process manager', () => {
  after(() => {
    stopAllBackgroundProcesses()
  })

  it('starts a server, detects its URL, exposes logs, and stops it', async () => {
    const info = await startBackgroundProcess({
      command: "printf 'Local:   http://localhost:4321/\\n'; sleep 30",
      cwd: process.cwd(),
      urlWaitMs: 4000,
    })
    assert.equal(info.running, true)
    assert.equal(info.url, 'http://localhost:4321')

    assert.ok(listBackgroundProcesses().some((p) => p.id === info.id))
    assert.match(getBackgroundProcessLogs(info.id) ?? '', /http:\/\/localhost:4321/)

    assert.equal(stopBackgroundProcess(info.id), true)
    assert.equal(
      listBackgroundProcesses().some((p) => p.id === info.id),
      false,
    )
    assert.equal(stopBackgroundProcess(info.id), false)
  })

  it('reports a command that exits immediately as not running', async () => {
    const info = await startBackgroundProcess({
      command: 'echo boom; exit 3',
      cwd: process.cwd(),
      urlWaitMs: 4000,
    })
    assert.equal(info.running, false)
    assert.equal(info.exitCode, 3)
    assert.equal(info.url, null)
  })

  it('rejects an empty command', async () => {
    await assert.rejects(
      () => startBackgroundProcess({ command: '   ', cwd: process.cwd() }),
      /command is required/,
    )
  })
})
