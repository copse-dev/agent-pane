import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sleep } from './sleep.ts'

describe('sleep', () => {
  it('resolves once the delay has passed', async () => {
    const started = performance.now()
    await sleep(20)
    // Timers can fire a hair early relative to performance.now(); allow slack.
    assert.ok(performance.now() - started >= 15)
  })

  it('resolves asynchronously even for a zero delay', async () => {
    let settled = false
    const pending = sleep(0).then(() => {
      settled = true
    })
    assert.equal(settled, false)
    await pending
    assert.equal(settled, true)
  })
})
