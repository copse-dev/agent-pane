import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RemoteChatClient, type RemoteThread } from './client.ts'

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

describe('remote browser chat replica', () => {
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
