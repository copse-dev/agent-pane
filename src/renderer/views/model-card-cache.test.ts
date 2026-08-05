import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearResolvedModelCards,
  hasResolvedModelCard,
  requestModelCards,
  resolvedModelCard,
  setResolvedModelCard,
} from './model-card-cache.ts'
import type { ModelCardCandidate } from '@copse/llm/model-card-candidates.ts'

const CARD: ModelCardCandidate = {
  url: 'https://example.invalid/card',
  title: 'A card',
  publisher: 'Example',
  kind: 'model-card',
  origin: 'curated',
}

/** Stub bridge that records the id batches it was asked for. */
function stubApi(answers: Record<string, ModelCardCandidate | null>): {
  resolve: (ids: string[]) => Promise<Record<string, ModelCardCandidate | null>>
  batches: string[][]
} {
  const batches: string[][] = []
  return {
    batches,
    resolve: (ids: string[]): Promise<Record<string, ModelCardCandidate | null>> => {
      batches.push(ids)
      return Promise.resolve(Object.fromEntries(ids.map((id) => [id, answers[id] ?? null])))
    },
  }
}

describe('model card cache', () => {
  beforeEach(() => {
    clearResolvedModelCards()
  })

  it('reads nothing before anything resolves', () => {
    assert.equal(resolvedModelCard('a'), null)
    assert.equal(hasResolvedModelCard('a'), false)
  })

  it('records an answer and reports it synchronously', async () => {
    const api = stubApi({ a: CARD })
    assert.equal(await requestModelCards(['a'], api), true)
    assert.equal(resolvedModelCard('a')?.url, CARD.url)
    assert.equal(hasResolvedModelCard('a'), true)
  })

  it('distinguishes "no card" from "not asked yet"', async () => {
    await requestModelCards(['a'], stubApi({}))
    assert.equal(resolvedModelCard('a'), null)
    // Asked and answered — so the caller must not ask again.
    assert.equal(hasResolvedModelCard('a'), true)
  })

  it('never re-requests an id it already has an answer for', async () => {
    const api = stubApi({ a: CARD, b: null })
    await requestModelCards(['a', 'b'], api)
    assert.equal(await requestModelCards(['a', 'b'], api), false)
    assert.equal(api.batches.length, 1, 'a resolved id must not be requested twice')
  })

  it('asks only for the ids it is missing', async () => {
    const api = stubApi({ a: CARD, b: CARD })
    await requestModelCards(['a'], api)
    await requestModelCards(['a', 'b'], api)
    assert.deepEqual(api.batches, [['a'], ['b']])
  })

  it('deduplicates ids within one request', async () => {
    const api = stubApi({ a: CARD })
    await requestModelCards(['a', 'a', 'a'], api)
    assert.deepEqual(api.batches, [['a']])
  })

  it('collapses concurrent requests for the same id', async () => {
    const api = stubApi({ a: CARD })
    await Promise.all([requestModelCards(['a'], api), requestModelCards(['a'], api)])
    assert.equal(api.batches.length, 1)
  })

  it('leaves an id unresolved when the bridge omits it, so a retry is possible', async () => {
    const partial = {
      batches: [] as string[][],
      resolve: (ids: string[]): Promise<Record<string, ModelCardCandidate | null>> => {
        partial.batches.push(ids)
        return Promise.resolve({})
      },
    }
    await requestModelCards(['a'], partial)
    assert.equal(hasResolvedModelCard('a'), false)
    await requestModelCards(['a'], partial)
    assert.equal(partial.batches.length, 2, 'an unanswered id must stay retryable')
  })

  it('treats a missing bridge as "no cards", not an error', async () => {
    assert.equal(await requestModelCards(['a'], undefined), false)
    assert.equal(hasResolvedModelCard('a'), false)
  })

  it('swallows a failing bridge and leaves the id retryable', async () => {
    const failing = {
      resolve: (): Promise<Record<string, ModelCardCandidate | null>> =>
        Promise.reject(new Error('ipc down')),
    }
    assert.equal(await requestModelCards(['a'], failing), false)
    assert.equal(hasResolvedModelCard('a'), false)
  })

  it('reports no change when every requested id was already known', async () => {
    setResolvedModelCard('a', CARD)
    assert.equal(await requestModelCards(['a'], stubApi({ a: CARD })), false)
  })
})
