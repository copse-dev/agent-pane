import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializedSet } from './persistence.ts'
import type { ApiClient } from '../../preload/api.d.ts'

function fakeApi(set: (key: string, value: unknown) => Promise<void>): ApiClient {
  return { storage: { get: async () => null, set } } as unknown as ApiClient
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('serializedSet applies writes to the same key in submission order', async () => {
  const calls: Array<[string, unknown]> = []
  const resolvers: Array<() => void> = []
  const api = fakeApi((key, value) => {
    calls.push([key, value])
    return new Promise<void>((r) => resolvers.push(r))
  })

  const p1 = serializedSet(api, 'k', 'first')
  const p2 = serializedSet(api, 'k', 'second')

  // The second write is held back until the first one resolves.
  await tick()
  assert.deepEqual(calls, [['k', 'first']])

  resolvers[0]!()
  await p1
  await tick()
  assert.deepEqual(calls, [
    ['k', 'first'],
    ['k', 'second'],
  ])

  resolvers[1]!()
  await p2
})

test('serializedSet does not serialize across different keys', async () => {
  const calls: string[] = []
  const api = fakeApi((key) => {
    calls.push(key)
    return Promise.resolve()
  })
  await Promise.all([serializedSet(api, 'a', 1), serializedSet(api, 'b', 2)])
  assert.deepEqual([...calls].sort(), ['a', 'b'])
})
