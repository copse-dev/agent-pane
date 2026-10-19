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

function read(
  changes: MobileActivityChanges,
  projectId: string,
  threadId: string,
  updatedAt: number,
  projectRoot = `/${projectId}`,
): boolean {
  return changes.read(projectId, threadId, updatedAt, projectRoot)
}

it('returns cold rows immediately while slow checks are deduplicated and bounded', async () => {
  const { changes, checks } = fixture()
  for (let id = 0; id < 10; id++) assert.equal(read(changes, 'p', String(id), 1), false)
  assert.equal(checks.length, 0, 'inspection starts after the synchronous read returns')
  await setImmediate()
  assert.equal(checks.length, 2, 'only two checks may run, even with ten visible threads')
  for (let id = 0; id < 10; id++) assert.equal(read(changes, 'p', String(id), 1), false)
  await setImmediate()
  assert.equal(checks.length, 2, 'repeat polls cannot duplicate queued or running work')

  // One hung checkout does not prevent another worker from progressing.
  result(checks, 1).resolve(true)
  await setImmediate()
  assert.equal(read(changes, 'p', '1', 1), true)
  assert.equal(read(changes, 'p', '0', 1), false)
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
  read(changes, 'p', 't', 1)
  await setImmediate()
  result(checks, 0).resolve(true)
  await setImmediate()
  mock.timers.tick(29_999)
  assert.equal(read(changes, 'p', 't', 1), true)
  await setImmediate()
  assert.equal(checks.length, 1)

  mock.timers.tick(1)
  assert.equal(read(changes, 'p', 't', 1), true, 'expiry must not make the list wait or flicker')
  await setImmediate()
  assert.equal(checks.length, 2)
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(read(changes, 'p', 't', 1), false)
})

it('refreshes changed metadata even when it changes during an in-flight check', async () => {
  const { changes, checks } = fixture()
  read(changes, 'p', 't', 1)
  await setImmediate()
  read(changes, 'p', 't', 2)
  result(checks, 0).resolve(true)
  await setImmediate()
  assert.equal(read(changes, 'p', 't', 2), true)
  await setImmediate()
  assert.deepEqual(
    checks.map((check) => check.updatedAt),
    [1, 2],
  )
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(read(changes, 'p', 't', 2), false)
})

it('isolates projects even when their thread ids match', async () => {
  const { changes, checks } = fixture()
  read(changes, 'first', 't', 1)
  read(changes, 'second', 't', 1)
  await setImmediate()
  assert.deepEqual(
    checks.map((check) => check.projectId),
    ['first', 'second'],
  )
  result(checks, 0).resolve(true)
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(read(changes, 'first', 't', 1), true)
  assert.equal(read(changes, 'second', 't', 1), false)
})

it('refreshes immediately when a project checkout root changes', async () => {
  const { changes, checks } = fixture()
  read(changes, 'p', 't', 1, '/projects/old')
  await setImmediate()
  result(checks, 0).resolve(true)
  await setImmediate()
  assert.equal(read(changes, 'p', 't', 1, '/projects/old'), true)

  assert.equal(
    read(changes, 'p', 't', 1, '/projects/new'),
    true,
    'the last known group remains visible while the new root is inspected',
  )
  await setImmediate()
  assert.equal(checks.length, 2)
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(read(changes, 'p', 't', 1, '/projects/new'), false)
})

it('handles failed checks without blocking the queue or retrying on every poll', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const { changes, checks } = fixture()
  read(changes, 'p', 'failed', 1)
  read(changes, 'p', 'other', 1)
  read(changes, 'p', 'queued', 1)
  await setImmediate()
  result(checks, 0).reject(new Error('Unavailable checkout'))
  result(checks, 1).resolve(false)
  await setImmediate()
  assert.equal(checks[2]?.threadId, 'queued')
  result(checks, 2).resolve(false)
  await setImmediate()
  assert.equal(read(changes, 'p', 'failed', 1), false)
  await setImmediate()
  assert.equal(checks.length, 3)
  mock.timers.tick(30_000)
  read(changes, 'p', 'failed', 1)
  await setImmediate()
  result(checks, 3).resolve(true)
  await setImmediate()
  assert.equal(read(changes, 'p', 'failed', 1), true)
})
