import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { DecodeFramesResult } from '@shared/video/decode-contract.ts'
import { settlePendingDecodeResponse, type PendingDecode } from './video-decoder.ts'

test('promptly rejects a malformed reply correlated to the pending decode', async () => {
  const requestId = '6c2bfc3a-9a67-40ec-8a40-fd9649a02dd2'
  let rejected: Error | undefined
  let timerFired = false
  const timer = setTimeout(() => {
    timerFired = true
  }, 0)
  timer.unref()
  const entry: PendingDecode = {
    resolve(_result: DecodeFramesResult): void {
      assert.fail('a malformed reply must not resolve the pending decode')
    },
    reject(error: Error): void {
      rejected = error
    },
    timer,
  }
  const pending = new Map([[requestId, entry]])

  settlePendingDecodeResponse(pending, { requestId, injected: '<script>' })

  assert.match(rejected?.message ?? '', /malformed reply/)
  assert.equal(pending.size, 0)
  await setImmediate()
  assert.equal(timerFired, false, 'the five-minute timeout must be cleared')
})
