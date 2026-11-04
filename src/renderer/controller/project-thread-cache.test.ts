import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Thread } from '@shared/types'
import { ProjectThreadCache } from './project-thread-cache.ts'

function thread(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [{ id: `${id}-m`, role: 'user', content: id, toolCalls: [], createdAt: 1 }],
  }
}

test('inactive transcripts share a bounded budget and keep an old selected row resident', () => {
  const cache = new ProjectThreadCache()
  const a = Array.from({ length: 20 }, (_, i) => thread(`a${String(i)}`))
  cache.remember('a', a, 0, 'a19')
  cache.remember('b', [thread('b')], 0, 'b')
  const snapshot = cache.get('a', 0)
  assert.ok(snapshot)
  assert.equal(snapshot.filter((t) => t.messagesLoaded !== false).length, 8)
  assert.equal(snapshot.find((t) => t.id === 'a19')?.messages[0]?.content, 'a19')
  assert.equal(a[0]?.messages.length, 1, 'eviction cannot mutate the active store array')
  assert.ok(
    snapshot.filter((t) => t.messagesLoaded === false).every((t) => t.messages.length === 0),
  )
})

test('resident metadata is bounded and invalidated by main-owned archive revisions', () => {
  const cache = new ProjectThreadCache()
  for (let i = 0; i < 20; i++) cache.remember(`p${String(i)}`, [thread(`t${String(i)}`)], 0)
  assert.equal(cache.get('p0', 0), undefined)
  assert.equal(cache.get('p19', 1), undefined)
  assert.ok(cache.get('p19', 0))
  cache.delete('p19')
  assert.equal(cache.get('p19', 0), undefined)
  cache.clear()
  assert.equal(cache.get('p18', 0), undefined)
})
