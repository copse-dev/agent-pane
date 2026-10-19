import assert from 'node:assert/strict'
import { afterEach, it, mock } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { MobileActivityChanges } from './mobile-activity-changes.ts'

afterEach(() => {
  mock.timers.reset()
})

interface Inspection {
  projectId: string
  threadId: string
  updatedAt: number
  result: PromiseWithResolvers<boolean>
}

function result(checks: Inspection[], index: number): PromiseWithResolvers<boolean> {
  const check = checks[index]
  assert.ok(check, `Expected inspection ${String(index)} to have started`)
  return check.result
}

function fixture(): { changes: MobileActivityChanges; checks: Inspection[] } {
  const checks: Inspection[] = []
  const changes = new MobileActivityChanges((projectId, threadId, updatedAt) => {
    const result = Promise.withResolvers<boolean>()
    checks.push({ projectId, threadId, updatedAt, result })
    return result.promise
  })
  return { changes, checks }
}

it('returns cold rows immediately while slow checks are deduplicated and bounded', async () => {
  const { changes, checks } = fixture()
  for (let id = 0; id < 10; id++) assert.equal(changes.read('p', String(id), 1), false)
  assert.equal(checks.length, 0, 'inspection starts after the synchronous read returns')
  await setImmediate()
  assert.equal(checks.length, 2, 'only two checks may run, even with ten visible threads')
  for (let id = 0; id < 10; id++) assert.equal(changes.read('p', String(id), 1), false)
  await setImmediate()
  assert.equal(checks.length, 2, 'repeat polls cannot duplicate queued or running work')

  // One hung checkout does not prevent another worker from progressing.
  result(checks, 1).resolve(true)
  await setImmediate()
  assert.equal(changes.read('p', '1', 1), true)
  assert.equal(changes.read('p', '0', 1), false)
  assert.equal(checks.length, 3)
  for (let index = 2; index < 10; index++) {
    result(checks, index).resolve(false)
    await setImmediate()
  }
  result(checks, 0).resolve(false)
  await setImmediate()
  assert.equal(checks.length, 10)
})

it('serves stale dirty results while refreshing and publishes the completed check on a later poll', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const { changes, checks } = fixture()
  changes.read('p', 't', 1)
  await setImmediate()
  result(checks, 0).resolve(true)
  await setImmediate()
  mock.timers.tick(29_999)
  assert.equal(changes.read('p', 't', 1), true)
  await setImmediate()
  assert.equal(checks.length, 1)

  mock.timers.tick(1)
  assert.equal(changes.read('p', 't', 1), true, 'expiry must not make the list wait or flicker')
  await setImmediate()
  assert.equal(checks.length, 2)
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(changes.read('p', 't', 1), false)
})

it('refreshes changed metadata even when it changes during an in-flight check', async () => {
  const { changes, checks } = fixture()
  changes.read('p', 't', 1)
  await setImmediate()
  changes.read('p', 't', 2)
  result(checks, 0).resolve(true)
  await setImmediate()
  assert.equal(changes.read('p', 't', 2), true)
  await setImmediate()
  assert.deepEqual(
    checks.map((check) => check.updatedAt),
    [1, 2],
  )
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(changes.read('p', 't', 2), false)
})

it('isolates projects even when their thread ids match', async () => {
  const { changes, checks } = fixture()
  changes.read('first', 't', 1)
  changes.read('second', 't', 1)
  await setImmediate()
  assert.deepEqual(
    checks.map((check) => check.projectId),
    ['first', 'second'],
  )
  result(checks, 0).resolve(true)
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(changes.read('first', 't', 1), true)
  assert.equal(changes.read('second', 't', 1), false)
})

it('handles failed checks without blocking the queue or retrying on every poll', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const { changes, checks } = fixture()
  changes.read('p', 'failed', 1)
  changes.read('p', 'other', 1)
  changes.read('p', 'queued', 1)
  await setImmediate()
  result(checks, 0).reject(new Error('Unavailable checkout'))
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(checks[2]?.threadId, 'queued')
  result(checks, 2).resolve(false)
  await setImmediate()
  assert.equal(changes.read('p', 'failed', 1), false)
  await setImmediate()
  assert.equal(checks.length, 3)
  mock.timers.tick(30_000)
  changes.read('p', 'failed', 1)
  await setImmediate()
  result(checks, 3).resolve(true)
  await setImmediate()
  assert.equal(changes.read('p', 'failed', 1), true)
})
