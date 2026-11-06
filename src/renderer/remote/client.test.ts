import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RemoteActions, RemoteChatClient, type RemoteThread } from './client.ts'
import { RemoteRequestError } from './transport.ts'

function thread(): RemoteThread {
  return {
    id: 't',
    title: 'Release',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [
      { id: 'u', role: 'user', content: 'Prepare the build', createdAt: 1, toolCalls: [] },
      { id: 'a', role: 'assistant', content: 'The build is ready', createdAt: 2, toolCalls: [] },
    ],
  }
}

describe('remote action delivery', () => {
  const payload = { action: 'message', text: 'Continue', projectId: 'p', threadId: 't' } as const

  it('reuses uncertain delivery identity but retires a known rejection', async () => {
    const bodies: (BodyInit | null | undefined)[] = []
    let attempt = 0
    const actions = new RemoteActions(
      async (_path, options) => {
        bodies.push(options?.body)
        attempt++
        if (attempt === 1) throw new Error('Connection lost')
        if (attempt === 2) throw new RemoteRequestError(409, 'Run changed')
        return { ok: true }
      },
      () => {
        throw new Error('Unexpected confirmation')
      },
    )
    await assert.rejects(actions.run(payload, 'session'))
    await assert.rejects(actions.run(payload, 'session'))
    await actions.run(payload, 'session')
    assert.equal(bodies[0], bodies[1])
    assert.notEqual(bodies[1], bodies[2])
  })

  it('requires confirmation before retrying an expired uncertain delivery', async () => {
    let requests = 0
    let confirmed = false
    const bodies: (BodyInit | null | undefined)[] = []
    const actions = new RemoteActions(
      async (_path, options) => {
        requests++
        bodies.push(options?.body)
        if (requests === 1)
          throw new RemoteRequestError(409, 'This action expired. Refresh and try again.')
        return { ok: true }
      },
      () => confirmed,
    )
    await assert.rejects(actions.run(payload, 'session'))
    await assert.rejects(actions.run(payload, 'session'), /Delivery is uncertain/)
    assert.equal(requests, 1)
    confirmed = true
    await actions.run(payload, 'session')
    assert.equal(requests, 2)
    assert.notEqual(bodies[0], bodies[1])
  })
})

describe('remote browser chat replica', () => {
  it('preserves snapshot identity across unchanged polls and hydrates unopened history once', async () => {
    let reads = 0
    let revision = 1
    let updatedAt = 2
    const client = new RemoteChatClient(async (path) => {
      if (path === '/api/remote/state')
        return {
          version: 1,
          sessionId: '11111111-1111-4111-8111-111111111111',
          revision,
          views: [
            {
              projectId: 'p',
              threads: [
                { ...thread(), updatedAt, messagesLoaded: false, messages: [thread().messages[1]] },
              ],
            },
          ],
        }
      reads++
      return { value: thread().messages }
    })
    const first = await client.snapshot()
    assert.equal(await client.snapshot(), first)
    const live = first.views[0]?.threads[0]
    assert.ok(live)
    assert.equal((await client.hydrate('p', live)).messages.length, 2)
    revision++
    const next = (await client.snapshot()).views[0]?.threads[0]
    assert.ok(next)
    await client.hydrate('p', next)
    assert.equal(reads, 1)
    updatedAt++
    revision++
    const changed = (await client.snapshot()).views[0]?.threads[0]
    assert.ok(changed)
    await client.hydrate('p', changed)
    assert.equal(reads, 2)
  })

  it('leaves metadata-only live views on the saved-transcript fallback', async () => {
    const client = new RemoteChatClient(async () => ({
      version: 1,
      sessionId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      views: [{ projectId: 'p', threads: [{ ...thread(), messagesLoaded: false, messages: [] }] }],
    }))
    assert.equal(await client.thread('p', 't'), null)
  })

  it('validates snapshots, caches hints per exchange and spends an accepted hint', async () => {
    let reads = 0
    const live = thread()
    const client = new RemoteChatClient(async (path) => {
      if (path === '/api/remote/state')
        return {
          version: 1,
          sessionId: '11111111-1111-4111-8111-111111111111',
          revision: 1,
          views: [{ projectId: 'p', threads: [live] }],
        }
      reads++
      return { value: reads === 1 ? true : 'Test the release build.' }
    })
    assert.equal((await client.thread('p', 't'))?.title, 'Release')
    assert.equal(await client.hint(live), 'Test the release build.')
    assert.equal(await client.hint(live), 'Test the release build.')
    assert.equal(reads, 2)
    client.spend('t')
    assert.equal(await client.hint(live), null)
    assert.equal(reads, 2)
  })

  it('never generates a hint for a running thread or queued user message', async () => {
    let reads = 0
    const client = new RemoteChatClient(async () => {
      reads++
      return null
    })
    const live = thread()
    assert.equal(await client.hint({ ...live, status: 'running' }), null)
    live.messages.push({
      id: 'q',
      role: 'user',
      content: 'Another task',
      createdAt: 3,
      toolCalls: [],
    })
    assert.equal(await client.hint(live), null)
    assert.equal(reads, 0)
  })

  it('rejects incompatible snapshots without changing the replica', async () => {
    const client = new RemoteChatClient(async () => ({ version: 99 }))
    await assert.rejects(client.thread('p', 't'))
  })
})
