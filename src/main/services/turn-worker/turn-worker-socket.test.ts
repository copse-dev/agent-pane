import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createConnection } from 'node:net'
import {
  connectTurnWorker,
  serveTurnWorker,
  turnWorkerSocketPath,
  type WorkerToApp,
} from './turn-worker-socket.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function profile(): string {
  // Short, so the socket stays inside the profile.
  const dir = mkdtempSync(join(tmpdir(), 'tw-'))
  dirs.push(dir)
  return dir
}

/**
 * Wait for `check` with a deadline in time, not in event-loop turns: a busy
 * machine moves a socket's bytes in fewer turns than a fixed count allows.
 */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.ok(check(), 'condition never held')
}

describe('turnWorkerSocketPath', () => {
  it('is stable per profile and thread, and stays short', () => {
    const a = turnWorkerSocketPath('/p', 't', 'linux')
    assert.equal(a, turnWorkerSocketPath('/p', 't', 'linux'))
    assert.notEqual(a, turnWorkerSocketPath('/p', 'u', 'linux'))
    assert.ok(a.startsWith('/p/run/'))
    const long = turnWorkerSocketPath(`/${'x'.repeat(120)}`, 't', 'darwin')
    assert.ok(long.length <= 120 && long.startsWith(tmpdir()))
    assert.match(turnWorkerSocketPath('/p', 't', 'win32'), /^\\\\\.\\pipe\\copse-turn-/)
  })
})

describe('turn worker socket', () => {
  it('replies to attach, streams after it, and takes stop', async () => {
    const path = turnWorkerSocketPath(profile(), 'thread')
    let stops = 0
    const server = await serveTurnWorker(path, {
      onAttach: () => {
        server.broadcast({ t: 'chunk', threadId: 't', chunk: { type: 'text', text: 'attached' } })
      },
      onStop: () => {
        stops += 1
      },
    })
    const received: WorkerToApp[] = []
    let closed = false
    const connection = await connectTurnWorker(
      path,
      (message) => received.push(message),
      () => {
        closed = true
      },
    )
    assert.ok(connection)
    try {
      // Nothing reaches an app that has not attached.
      server.broadcast({ t: 'chunk', threadId: 't', chunk: { type: 'text', text: 'early' } })
      connection.send({ t: 'attach' })
      await until(() => received.length === 1)
      server.broadcast({
        t: 'chunk',
        threadId: 't',
        chunk: { type: 'text', text: 'hi' },
        stamp: { messageIds: ['m1'] },
      })
      await until(() => received.length === 2)
      assert.deepEqual(received[0], {
        t: 'chunk',
        threadId: 't',
        chunk: { type: 'text', text: 'attached' },
      })
      assert.deepEqual(received[1], {
        t: 'chunk',
        threadId: 't',
        chunk: { type: 'text', text: 'hi' },
        stamp: { messageIds: ['m1'] },
      })

      connection.send({ t: 'stop' })
      await until(() => stops === 1)
    } finally {
      await server.close()
    }
    await until(() => closed)
  })

  it('ignores lines that are not part of the protocol', async () => {
    const path = turnWorkerSocketPath(profile(), 'thread')
    let calls = 0
    const server = await serveTurnWorker(path, {
      onAttach: () => (calls += 1),
      onStop: () => (calls += 1),
    })
    const connection = await connectTurnWorker(
      path,
      () => undefined,
      () => undefined,
    )
    assert.ok(connection)
    try {
      await new Promise<void>((resolve) => {
        const raw = createConnection(path, () => {
          raw.end('{"t":"exec","command":"rm -rf /"}\nnot json\n', resolve)
        })
      })
      connection.send({ t: 'attach' })
      await until(() => calls === 1)
    } finally {
      connection.close()
      await server.close()
    }
  })

  it('finds nobody listening', async () => {
    const path = turnWorkerSocketPath(profile(), 'absent')
    assert.equal(
      await connectTurnWorker(
        path,
        () => undefined,
        () => undefined,
      ),
      null,
    )
  })
})
