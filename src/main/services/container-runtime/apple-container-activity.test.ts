import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withAppleBuilderLock } from './apple-container-activity.ts'

test(
  'native builder lock excludes simultaneous cleanup and releases after success and failure',
  { skip: process.platform !== 'darwin' },
  async () => {
    await withAppleBuilderLock(async () => {
      await assert.rejects(
        withAppleBuilderLock(async () => 'unexpected'),
        /busy/,
      )
    })
    await assert.rejects(
      withAppleBuilderLock(async () => {
        throw new Error('callback failed')
      }),
      /callback failed/,
    )
    assert.equal(await withAppleBuilderLock(async () => 'released'), 'released')
  },
)
