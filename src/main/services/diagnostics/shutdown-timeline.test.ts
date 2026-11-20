import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  logOpenShutdownSteps,
  markShutdown,
  timeShutdownStep,
  timeShutdownStepAsync,
} from './shutdown-timeline.ts'

const saved = {
  e2e: process.env['COPSE_E2E'],
  debug: process.env['COPSE_DEBUG_SHUTDOWN'],
  log: console.log,
}
let logged: string[] = []

function restore(name: 'COPSE_E2E' | 'COPSE_DEBUG_SHUTDOWN', value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

beforeEach(() => {
  logged = []
  console.log = (...args: unknown[]): void => {
    logged.push(args.map(String).join(' '))
  }
  Reflect.deleteProperty(process.env, 'COPSE_E2E')
  Reflect.deleteProperty(process.env, 'COPSE_DEBUG_SHUTDOWN')
})

afterEach(() => {
  console.log = saved.log
  restore('COPSE_E2E', saved.e2e)
  restore('COPSE_DEBUG_SHUTDOWN', saved.debug)
})

describe('shutdown timeline', () => {
  it('is silent and calls straight through when neither flag is set', async () => {
    let ran = 0
    timeShutdownStep('sync', () => {
      ran += 1
    })
    const pending = Promise.resolve(7)
    assert.equal(
      timeShutdownStepAsync('async', () => pending),
      pending,
      'the bare promise comes back',
    )
    assert.equal(await timeShutdownStepAsync('async', () => pending), 7)
    markShutdown('milestone')
    logOpenShutdownSteps('deadline')
    assert.equal(ran, 1)
    assert.deepEqual(logged, [])
  })

  it('logs each step start and end under COPSE_E2E=1', async () => {
    process.env['COPSE_E2E'] = '1'
    timeShutdownStep('sync', () => undefined)
    assert.equal(await timeShutdownStepAsync('async', () => Promise.resolve(3)), 3)
    markShutdown('cleanup:outcome completed')
    assert.equal(logged.length, 5)
    assert.equal(logged[0], '[shutdown] step:start sync')
    assert.match(logged[1] ?? '', /^\[shutdown\] step:end sync [\d.]+ms ok$/)
    assert.match(logged[3] ?? '', /^\[shutdown\] step:end async [\d.]+ms ok$/)
    assert.equal(logged[4], '[shutdown] cleanup:outcome completed')
  })

  it('keeps a synchronous throw synchronous and names the steps still open', async () => {
    process.env['COPSE_DEBUG_SHUTDOWN'] = '1'
    assert.throws(() =>
      timeShutdownStepAsync('throws', () => {
        throw new Error('boom')
      }),
    )
    await assert.rejects(timeShutdownStepAsync('rejects', () => Promise.reject(new Error('no'))))
    const never = timeShutdownStepAsync('hangs', () => new Promise<void>(() => undefined))
    logOpenShutdownSteps('deadline')
    assert.match(logged.at(-1) ?? '', /^\[shutdown\] deadline: open steps hangs\(\d+ms\)$/)
    assert.ok(logged.some((line) => /step:end throws .* threw$/.test(line)))
    assert.ok(logged.some((line) => /step:end rejects .* rejected$/.test(line)))
    void never
  })
})
