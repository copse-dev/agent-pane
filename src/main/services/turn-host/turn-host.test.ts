import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { chatGptPlanModelValue } from '@copse/llm/chatgpt-plan.ts'
import {
  acquireWriterLease,
  WRITER_LEASE_FILE,
  type WriterLeaseEnvironment,
} from '@copse/thread-store/writer-lease.ts'
import type { Thread } from '@shared/types'
import { ToolRegistry } from '../tool-registry.ts'
import {
  loadProjectThreadMetas,
  loadThreadMessages,
  saveProjectThread,
  threadDirectoryPath,
} from '../thread-store.ts'
import type { HostToApp, TurnHostClient } from './turn-host-protocol.ts'
import { readHostDispatchRecord } from './host-dispatch-record.ts'
import { TurnHost } from './turn-host.ts'

let root = ''
const savedDir = process.env['COPSE_DIR']
const savedMock = process.env['COPSE_PANEL_MOCK_LLM']
before(() => {
  root = mkdtempSync(join(tmpdir(), 'turn-host-'))
  process.env['COPSE_DIR'] = root
  process.env['COPSE_PANEL_MOCK_LLM'] = '1'
})
after(() => {
  if (savedDir === undefined) delete process.env['COPSE_DIR']
  else process.env['COPSE_DIR'] = savedDir
  if (savedMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
  else process.env['COPSE_PANEL_MOCK_LLM'] = savedMock
  rmSync(root, { recursive: true, force: true })
})

const VERSION = '1.2.3'
const silent = (): void => undefined

function idleThread(id: string, overrides: Partial<Thread> = {}): Thread {
  const at = Date.now() - 60_000
  return {
    id,
    title: 'Plan',
    status: 'idle',
    model: 'claude-sonnet-4-6',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

/** An app on the other end of the line, recording what the host sends it. */
function app(): { client: TurnHostClient; sent: HostToApp[]; joined: () => boolean } {
  const sent: HostToApp[] = []
  let joined = false
  return {
    client: {
      join: (): void => {
        joined = true
      },
      send: (message): void => {
        sent.push(message)
        changes.poke()
      },
    },
    sent,
    joined: () => joined,
  }
}

function host(overrides: Partial<ConstructorParameters<typeof TurnHost>[0]> = {}): {
  host: TurnHost
  broadcast: HostToApp[]
} {
  const broadcast: HostToApp[] = []
  const turnHost = new TurnHost({
    registry: new ToolRegistry(),
    log: silent,
    version: VERSION,
    onIdle: (): void => undefined,
    idleMs: 60_000,
    ...overrides,
  })
  turnHost.bindBroadcast((message) => {
    broadcast.push(message)
    changes.poke()
  })
  return { host: turnHost, broadcast }
}

/** Wakes whoever waits on a condition each time something it reads changes. */
class Changes {
  private readonly waiters = new Set<() => void>()
  poke(): void {
    for (const waiter of this.waiters) waiter()
  }
  until(check: () => boolean): Promise<void> {
    if (check()) return Promise.resolve()
    return new Promise((resolve) => {
      const waiter = (): void => {
        if (!check()) return
        this.waiters.delete(waiter)
        resolve()
      }
      this.waiters.add(waiter)
    })
  }
}

const changes = new Changes()

function until(check: () => boolean, _what: string): Promise<void> {
  return changes.until(check)
}

function ended(sent: HostToApp[], id: string): boolean {
  return sent.some((message) => message.t === 'ended' && message.id === id)
}

describe('TurnHost', { timeout: 30_000 }, () => {
  it('runs turns on two threads and lets each thread go', async () => {
    await saveProjectThread('p1', idleThread('a'))
    await saveProjectThread('p1', idleThread('b'))
    const { host: turnHost, broadcast } = host()
    const peer = app()
    turnHost.handle({ t: 'hello', version: VERSION, protocol: 1 }, peer.client)
    turnHost.handle({ t: 'attach' }, peer.client)
    turnHost.handle(
      { t: 'dispatch', id: 'd1', projectId: 'p1', threadId: 'a', payload: 'Summarise PLAN.md' },
      peer.client,
    )
    turnHost.handle(
      { t: 'dispatch', id: 'd2', projectId: 'p1', threadId: 'b', payload: 'List the steps' },
      peer.client,
    )
    await until(() => ended(peer.sent, 'd1') && ended(peer.sent, 'd2'), 'both turns')

    assert.equal(peer.sent[0]?.t, 'hello')
    for (const id of ['d1', 'd2']) {
      const kinds = peer.sent.filter((m) => 'id' in m && m.id === id).map((m) => m.t)
      assert.deepEqual(kinds, ['accepted', 'ended'], `turn ${id}`)
      const end = peer.sent.find((m) => m.t === 'ended' && m.id === id)
      assert.equal(end && 'error' in end ? end.error : undefined, undefined)
    }
    for (const threadId of ['a', 'b']) {
      const roles = (await loadThreadMessages('p1', threadId)).map((m) => m.role)
      // The window saves the user's message before it sends the turn, as it
      // does for a turn main runs; the host writes the reply.
      assert.deepEqual(roles, ['assistant'], `thread ${threadId}`)
      const meta = (await loadProjectThreadMetas('p1')).find((m) => m.id === threadId)
      assert.equal(meta?.status, 'idle')
      assert.equal(existsSync(join(threadDirectoryPath('p1', threadId), WRITER_LEASE_FILE)), false)
      assert.ok(
        broadcast.some((m) => m.t === 'chunk' && m.threadId === threadId),
        `the attached app saw thread ${threadId} stream`,
      )
    }
    assert.deepEqual(turnHost.activeThreadIds(), [])
    const record = await readHostDispatchRecord(threadDirectoryPath('p1', 'a'))
    assert.equal(record?.operationId, 'd1')
    assert.equal(record.state, 'ended')
    turnHost.dispose()
  })

  it('runs a repeated operation id once, and reports it by id', async () => {
    await saveProjectThread('p1', idleThread('g'))
    const { host: turnHost } = host()
    const peer = app()
    turnHost.handle({ t: 'hello', version: VERSION, protocol: 1 }, peer.client)
    const dispatch = {
      t: 'dispatch' as const,
      id: 'd7',
      projectId: 'p1',
      threadId: 'g',
      payload: 'Hello',
    }
    turnHost.handle(dispatch, peer.client)
    await until(() => ended(peer.sent, 'd7'), 'the turn')
    // The app lost the answer and sends the same operation again.
    turnHost.handle(dispatch, peer.client)
    turnHost.handle({ t: 'status', id: 'd7' }, peer.client)
    turnHost.handle({ t: 'status', id: 'never-sent' }, peer.client)
    await until(() => peer.sent.filter((m) => m.t === 'status').length === 3, 'the answers')
    assert.deepEqual(
      peer.sent.flatMap((m) => (m.t === 'status' ? [[m.id, m.state]] : [])),
      [
        ['d7', 'ended'],
        ['d7', 'ended'],
        ['never-sent', 'unknown'],
      ],
    )
    assert.equal((await loadThreadMessages('p1', 'g')).length, 1, 'one reply, not two')
    turnHost.dispose()
  })

  it('runs nothing for an app of another version, and retires', async () => {
    await saveProjectThread('p1', idleThread('c'))
    let idle = 0
    const { host: turnHost } = host({
      onIdle: () => {
        idle += 1
        changes.poke()
      },
    })
    const peer = app()
    turnHost.handle({ t: 'hello', version: '9.9.9', protocol: 1 }, peer.client)
    turnHost.handle(
      { t: 'dispatch', id: 'd3', projectId: 'p1', threadId: 'c', payload: 'Hello' },
      peer.client,
    )
    await until(() => peer.sent.some((m) => m.t === 'refused'), 'the refusal')
    assert.equal(idle, 1, 'a retiring host with no turns goes at once')
    assert.equal((await loadThreadMessages('p1', 'c')).length, 0)
    turnHost.dispose()
  })

  it('leaves turns it cannot run to the app', async () => {
    await saveProjectThread(
      'p1',
      idleThread('d', { model: chatGptPlanModelValue('codex', 'gpt-5') }),
    )
    await saveProjectThread('p1', idleThread('e'))
    const { host: turnHost } = host()
    const peer = app()
    turnHost.handle({ t: 'hello', version: VERSION, protocol: 1 }, peer.client)
    turnHost.handle(
      { t: 'dispatch', id: 'd4', projectId: 'p1', threadId: 'd', payload: 'Hello' },
      peer.client,
    )
    turnHost.handle(
      {
        t: 'dispatch',
        id: 'd5',
        projectId: 'p1',
        threadId: 'e',
        payload: JSON.stringify({ content: 'Hello', model: 'acp:claude-acp' }),
      },
      peer.client,
    )
    await until(() => peer.sent.filter((m) => m.t === 'refused').length === 2, 'both refusals')
    const reasons = peer.sent.flatMap((m) => (m.t === 'refused' ? [m.reason] : []))
    assert.match(reasons.join('\n'), /ChatGPT/)
    assert.match(reasons.join('\n'), /external coding agent/)
    for (const threadId of ['d', 'e']) {
      assert.equal((await loadThreadMessages('p1', threadId)).length, 0)
    }
    turnHost.dispose()
  })

  it('refuses a thread another process holds', async () => {
    await saveProjectThread('p1', idleThread('f'))
    const other: WriterLeaseEnvironment = {
      owner: { id: 'the-app', host: hostname(), pid: process.ppid },
      now: Date.now,
      isAlive: () => true,
    }
    const held = await acquireWriterLease(threadDirectoryPath('p1', 'f'), 'f', other)
    assert.equal(held.status, 'acquired')
    const { host: turnHost } = host()
    const peer = app()
    turnHost.handle({ t: 'hello', version: VERSION, protocol: 1 }, peer.client)
    turnHost.handle(
      { t: 'dispatch', id: 'd6', projectId: 'p1', threadId: 'f', payload: 'Hello' },
      peer.client,
    )
    await until(() => peer.sent.some((m) => m.t === 'refused' || m.t === 'ended'), 'an answer')
    const kinds = peer.sent.filter((m) => 'id' in m && m.id === 'd6').map((m) => m.t)
    assert.deepEqual(kinds, ['refused'])
    assert.equal(
      await readHostDispatchRecord(threadDirectoryPath('p1', 'f')),
      null,
      'a refused turn leaves no record, so the app may run it',
    )
    assert.equal((await loadThreadMessages('p1', 'f')).length, 0)
    turnHost.dispose()
  })

  it('goes idle only with no turn and no app attached', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let idle = 0
    const { host: turnHost } = host({ idleMs: 1_000, onIdle: () => (idle += 1) })
    const peer = app()
    turnHost.handle({ t: 'hello', version: VERSION, protocol: 1 }, peer.client)
    turnHost.handle({ t: 'attach' }, peer.client)
    assert.equal(peer.joined(), true)
    context.mock.timers.tick(5_000)
    assert.equal(idle, 0, 'an attached app keeps the host up')
    turnHost.left()
    context.mock.timers.tick(999)
    assert.equal(idle, 0)
    context.mock.timers.tick(1)
    assert.equal(idle, 1)
    turnHost.dispose()
  })
})
