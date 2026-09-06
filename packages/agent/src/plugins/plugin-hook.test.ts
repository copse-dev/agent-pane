import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HOOK_EVENT_NAMES } from '../hooks/canonical-events.ts'
import {
  validatePluginHookRegistrations,
  zPluginHookRegistration,
  zPluginHookRegistrations,
} from './plugin-hook.ts'

describe('external hook declarations', () => {
  it('accepts every canonical event and rejects unknown events and malformed declarations', () => {
    for (const event of HOOK_EVENT_NAMES) {
      assert.deepEqual(zPluginHookRegistration.parse({ id: 'hook', event }), { id: 'hook', event })
    }
    for (const event of [
      '*',
      'tool.call',
      'constructor',
      'toString',
      ...HOOK_EVENT_NAMES.map((e) => `${e} `),
    ]) {
      assert.equal(zPluginHookRegistration.safeParse({ id: 'hook', event }).success, false)
    }
    for (const value of [
      null,
      [],
      {},
      { id: '', event: 'turnStart' },
      { id: 'x', event: 'turnStart', command: 'echo x' },
    ]) {
      assert.equal(zPluginHookRegistration.safeParse(value).success, false)
    }
  })

  it('requires exact ids and events, allowing registration order to differ from declaration order', () => {
    const a = zPluginHookRegistration.parse({ id: 'a', event: 'turnStart' })
    const b = zPluginHookRegistration.parse({ id: 'b', event: 'stop' })
    validatePluginHookRegistrations([a, b], [b, a])
    for (const actual of [[], [a], [a, a], [a, { ...b, event: a.event }]]) {
      assert.throws(() => {
        validatePluginHookRegistrations([a, b], actual)
      })
    }
    assert.throws(() => {
      validatePluginHookRegistrations([], [a])
    })
    assert.equal(
      zPluginHookRegistrations.safeParse(
        Array.from({ length: 1_001 }, (_, i) => ({ ...a, id: String(i) })),
      ).success,
      false,
    )
  })
})
