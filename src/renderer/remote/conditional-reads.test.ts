import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ConditionalReads, conditionalGet } from './conditional-reads.ts'

describe('conditional reads', () => {
  it('offers the validator of an answer it holds, and returns that same answer', () => {
    const reads = new ConditionalReads()
    assert.equal(reads.validator('/api/activity'), undefined)
    const answer = { rows: [] }
    reads.remember('/api/activity', 'W/"a"', answer)
    assert.equal(reads.validator('/api/activity'), 'W/"a"')
    assert.equal(reads.held('/api/activity')?.value, answer)
    assert.equal(reads.validator('/api/thread/p/t'), undefined)
  })

  it('does not keep an answer it could never confirm', () => {
    const reads = new ConditionalReads()
    reads.remember('/api/thread/p/t/image/m/0', null, { image: 'data:image/png;base64,AAAA' })
    assert.equal(reads.held('/api/thread/p/t/image/m/0'), undefined)
    // A newer answer without a validator also retires the one it replaces.
    reads.remember('/api/activity', 'W/"a"', {})
    reads.remember('/api/activity', null, {})
    assert.equal(reads.validator('/api/activity'), undefined)
  })

  it('holds only the few most recently answered reads', () => {
    const reads = new ConditionalReads(2)
    reads.remember('/a', 'W/"a"', 'a')
    reads.remember('/b', 'W/"b"', 'b')
    reads.remember('/a', 'W/"a2"', 'a2')
    reads.remember('/c', 'W/"c"', 'c')
    assert.equal(reads.held('/b'), undefined)
    assert.equal(reads.held('/a')?.value, 'a2')
    assert.equal(reads.held('/c')?.value, 'c')
    reads.clear()
    assert.equal(reads.validator('/a'), undefined)
  })

  it('holds a null answer as an answer', () => {
    const reads = new ConditionalReads()
    reads.remember('/a', 'W/"a"', null)
    assert.deepEqual(reads.held('/a'), { value: null })
  })
})

describe('conditional GET', () => {
  const answer = (status: number, etag?: string): Response =>
    new Response(status === 304 ? null : '{}', { status, headers: etag ? { ETag: etag } : {} })

  it('sends no validator for a first read', async () => {
    const reads = new ConditionalReads()
    const sent: Record<string, string>[] = []
    const result = await conditionalGet(reads, '/a', (headers) => {
      sent.push(headers)
      return Promise.resolve(answer(200, 'W/"a"'))
    })
    assert.deepEqual(sent, [{}])
    assert.ok('response' in result)
    assert.equal(result.response.status, 200)
  })

  it('returns the held answer itself when the Mac confirms it', async () => {
    const reads = new ConditionalReads()
    const held = { rows: [1] }
    reads.remember('/a', 'W/"a"', held)
    const sent: Record<string, string>[] = []
    const result = await conditionalGet(reads, '/a', (headers) => {
      sent.push(headers)
      return Promise.resolve(answer(304))
    })
    assert.deepEqual(sent, [{ 'If-None-Match': 'W/"a"' }])
    assert.ok('unchanged' in result)
    assert.equal(result.unchanged, held)
  })

  it('passes a changed answer through', async () => {
    const reads = new ConditionalReads()
    reads.remember('/a', 'W/"a"', {})
    const result = await conditionalGet(reads, '/a', () => Promise.resolve(answer(200, 'W/"b"')))
    assert.ok('response' in result)
    assert.equal(result.response.headers.get('ETag'), 'W/"b"')
  })

  it('asks again in full when the held answer went away mid-request', async () => {
    const reads = new ConditionalReads()
    reads.remember('/a', 'W/"a"', {})
    const sent: Record<string, string>[] = []
    const result = await conditionalGet(reads, '/a', (headers) => {
      sent.push(headers)
      reads.clear()
      return Promise.resolve(answer(sent.length === 1 ? 304 : 200, 'W/"a"'))
    })
    assert.deepEqual(sent, [{ 'If-None-Match': 'W/"a"' }, {}])
    assert.ok('response' in result)
    assert.equal(result.response.status, 200)
  })
})
