import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import {
  requestViaServer,
  shutdownSandboxFsServer,
  isSandboxFsServerLive,
  setWorkerSpawnerForTest,
  SandboxFsServerUnavailable,
} from './sandbox-fs-server.ts'

/**
 * Stand-in worker (plain CJS so it runs under the test node without TS/Electron). Implements the
 * same newline-delimited `{ id, ...body }` protocol as sandbox-fs-worker.ts; `op: 'die'` exits
 * without replying to exercise crash handling.
 */
const ECHO_WORKER = `
const fs = require('node:fs/promises');
let buf = '';
const reply = (id, body) => process.stdout.write(JSON.stringify({ id, ...body }) + '\\n');
async function handle(req) {
  try {
    if (req.op === 'die') return process.exit(1);
    if (req.op === 'statDir') {
      const d = await fs.readdir(req.path, { withFileTypes: true });
      return reply(req.id, { ok: true, dirents: d.map((e) => ({ name: e.name, isDir: e.isDirectory() })) });
    }
    if (req.op === 'readFile') {
      return reply(req.id, { ok: true, data: await fs.readFile(req.path, req.encoding) });
    }
    reply(req.id, { ok: false, error: 'unknown op: ' + req.op });
  } catch (e) {
    reply(req.id, { ok: false, error: String((e && e.message) || e) });
  }
}
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
`

function echoSpawner(): ChildProcess {
  return spawn(process.execPath, ['-e', ECHO_WORKER], { stdio: 'pipe' })
}

describe('sandbox-fs-server', () => {
  afterEach(() => {
    shutdownSandboxFsServer()
    setWorkerSpawnerForTest(null)
  })

  it('rejects with SandboxFsServerUnavailable when no workspace is open', async () => {
    const restore = setWorkspaceRootForTest(null)
    try {
      await assert.rejects(
        requestViaServer({ op: 'statDir', path: '/' }),
        (err: unknown) => err instanceof SandboxFsServerUnavailable,
      )
    } finally {
      restore()
    }
  })

  it('serves concurrent requests over one worker, correlating responses by id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-sbfs-server-'))
    const restore = setWorkspaceRootForTest(dir)
    setWorkerSpawnerForTest(() => Promise.resolve(echoSpawner()))
    try {
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf-8')

      const [listing, file] = await Promise.all([
        requestViaServer({ op: 'statDir', path: dir }),
        requestViaServer({ op: 'readFile', path: join(dir, 'a.txt'), encoding: 'utf-8' }),
      ])

      assert.equal(listing.ok, true)
      assert.equal(file.ok, true)
      assert.equal(file['data'], 'hello')
      const dirents = listing['dirents'] as { name: string }[]
      assert.ok(dirents.some((d) => d.name === 'a.txt'))
      assert.equal(isSandboxFsServerLive(), true)
    } finally {
      restore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reuses the same worker across sequential requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-sbfs-reuse-'))
    const restore = setWorkspaceRootForTest(dir)
    let spawnCount = 0
    setWorkerSpawnerForTest(() => {
      spawnCount += 1
      return Promise.resolve(echoSpawner())
    })
    try {
      await requestViaServer({ op: 'statDir', path: dir })
      await requestViaServer({ op: 'statDir', path: dir })
      await requestViaServer({ op: 'statDir', path: dir })
      assert.equal(spawnCount, 1)
    } finally {
      restore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects in-flight requests when the worker crashes, then respawns on the next call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-sbfs-crash-'))
    const restore = setWorkspaceRootForTest(dir)
    let spawnCount = 0
    setWorkerSpawnerForTest(() => {
      spawnCount += 1
      return Promise.resolve(echoSpawner())
    })
    try {
      await assert.rejects(
        requestViaServer({ op: 'die', path: dir }),
        (err: unknown) => err instanceof SandboxFsServerUnavailable,
      )
      assert.equal(isSandboxFsServerLive(), false)

      const listing = await requestViaServer({ op: 'statDir', path: dir })
      assert.equal(listing.ok, true)
      assert.equal(spawnCount, 2)
    } finally {
      restore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
