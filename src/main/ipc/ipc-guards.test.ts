import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INDEX_QUERY_PATTERN,
  estimateContextPayloadSchema,
  followUpContextSchema,
  isIndexQueryPattern,
  lmStudioDetectSchema,
  lmStudioDownloadSchema,
  lmStudioTestSchema,
  zHttpUrl,
  zModelId,
  zThreadId,
} from './ipc-guards.ts'

describe('ipc-guards index query', () => {
  it('accepts normal search substrings', () => {
    assert.match('foo-bar.ts', INDEX_QUERY_PATTERN)
    assert.equal(isIndexQueryPattern('foo-bar.ts'), true)
  })

  it('rejects glob metacharacters', () => {
    assert.equal(isIndexQueryPattern('{a,b}'), false)
    assert.equal(isIndexQueryPattern('**'), false)
  })
})

describe('ipc-guards zThreadId', () => {
  it('accepts safe thread ids', () => {
    assert.equal(zThreadId.safeParse('thread-123').success, true)
    assert.equal(zThreadId.safeParse('abc_DEF-09').success, true)
  })

  it('rejects key-injection and out-of-range ids', () => {
    assert.equal(zThreadId.safeParse('').success, false)
    assert.equal(zThreadId.safeParse('a:b').success, false)
    assert.equal(zThreadId.safeParse('../etc').success, false)
    assert.equal(zThreadId.safeParse('llm-history:x').success, false)
    assert.equal(zThreadId.safeParse('a'.repeat(129)).success, false)
  })
})

describe('ipc-guards zHttpUrl', () => {
  it('accepts http(s) urls including loopback', () => {
    assert.equal(zHttpUrl.safeParse('http://localhost:1234/v1').success, true)
    assert.equal(zHttpUrl.safeParse('https://example.com').success, true)
  })

  it('rejects non-http schemes and non-urls', () => {
    assert.equal(zHttpUrl.safeParse('file:///etc/passwd').success, false)
    assert.equal(zHttpUrl.safeParse('ftp://host/x').success, false)
    assert.equal(zHttpUrl.safeParse('not a url').success, false)
  })
})

describe('ipc-guards lmstudio schemas', () => {
  it('parses a test tuple with optional api key', () => {
    assert.deepEqual(lmStudioTestSchema.parse(['http://localhost:1234/v1', undefined]), [
      'http://localhost:1234/v1',
      undefined,
    ])
    assert.equal(lmStudioTestSchema.safeParse(['ws://x', 'k']).success, false)
  })

  it('allows an optional url for detect', () => {
    assert.equal(lmStudioDetectSchema.safeParse([undefined, undefined]).success, true)
    assert.equal(lmStudioDetectSchema.safeParse(['file:///x', undefined]).success, false)
  })

  it('requires a bounded model id for download', () => {
    assert.equal(zModelId.safeParse('qwen2.5-coder').success, true)
    assert.equal(zModelId.safeParse('').success, false)
    assert.equal(lmStudioDownloadSchema.safeParse(['m', undefined, undefined]).success, true)
    assert.equal(lmStudioDownloadSchema.safeParse(['', undefined, undefined]).success, false)
  })
})

describe('ipc-guards agent payload schemas', () => {
  it('validates estimate-context payloads, rejecting wrong shapes', () => {
    assert.equal(estimateContextPayloadSchema.safeParse({}).success, true)
    assert.equal(
      estimateContextPayloadSchema.safeParse({ draftText: 'hi', imageCount: 2 }).success,
      true,
    )
    assert.equal(estimateContextPayloadSchema.safeParse({ imageCount: 'two' }).success, false)
    assert.equal(estimateContextPayloadSchema.safeParse(null).success, false)
    // Per-thread model override is accepted so the estimate uses the thread's model.
    assert.equal(estimateContextPayloadSchema.safeParse({ model: 'claude-opus-4-8' }).success, true)
    assert.equal(estimateContextPayloadSchema.safeParse({ model: 42 }).success, false)
  })

  it('validates follow-up context shape', () => {
    assert.equal(
      followUpContextSchema.safeParse({
        userMessage: 'u',
        assistantMessage: 'a',
        toolNames: ['bash'],
      }).success,
      true,
    )
    assert.equal(followUpContextSchema.safeParse({ userMessage: 'u' }).success, false)
    assert.equal(followUpContextSchema.safeParse('nope').success, false)
  })
})
