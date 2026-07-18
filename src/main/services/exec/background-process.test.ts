import { describe, it, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import {
  classifyDetectedServerUrl,
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

  it('starts a port-binding server, detects its URL, exposes logs, and stops it', async () => {
    const info = await startBackgroundProcess({
      command: "printf 'Local:   http://localhost:4321/\\n'; sleep 30",
      cwd: process.cwd(),
      allowPortBinding: true,
      waitMs: 4000,
    })
    assert.equal(info.running, true)
    assert.equal(info.url, 'http://localhost:4321')
    assert.equal(info.urlRemote, false)

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
      waitMs: 4000,
    })
    assert.equal(info.running, false)
    assert.equal(info.exitCode, 3)
    assert.equal(info.url, null)
  })

  it('does not surface a URL for a plain task that did not opt into port binding', async () => {
    const info = await startBackgroundProcess({
      command: "printf 'Local:   http://localhost:4321/\\n'; sleep 30",
      cwd: process.cwd(),
      waitMs: 400,
    })
    assert.equal(info.running, true)
    assert.equal(info.url, null, 'URL detection is gated behind allowPortBinding')
    stopBackgroundProcess(info.id)
  })

  it('rejects an empty command', async () => {
    await assert.rejects(
      () => startBackgroundProcess({ command: '   ', cwd: process.cwd() }),
      /command is required/,
    )
  })
})

describe('classifyDetectedServerUrl', () => {
  beforeEach(async () => {
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: '/remote/project', sshHost: 'dev' }])
    setWorkspaceRootForTest('/remote/project')
  })

  afterEach(() => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    void setSetting('sshWorkspaceEnabled', false)
    void setSetting('sshWorkspaceHosts', [])
  })

  it('marks detected loopback URLs as remote when SSH execution is active', () => {
    assert.deepEqual(classifyDetectedServerUrl('Local:   http://localhost:4321/'), {
      url: 'http://localhost:4321',
      urlRemote: true,
    })
  })

  it('keeps URLs local when SSH execution is disabled', async () => {
    await setSetting('sshWorkspaceEnabled', false)
    assert.deepEqual(classifyDetectedServerUrl('Local:   http://localhost:4321/'), {
      url: 'http://localhost:4321',
      urlRemote: false,
    })
  })
})
