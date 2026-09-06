import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { activatePluginTools, type PluginToolActivationApi } from './plugin-tool-sdk.ts'
import { zPluginToolHostRequest, zPluginToolRegistrations } from './plugin-tool-protocol.ts'

describe('external hook SDK and protocol', () => {
  it('registers hooks in order and invokes only the requested handler with narrow context', async () => {
    let later: (() => void) | undefined
    const seen: string[] = []
    const activated = await activatePluginTools(
      {
        activate(api: PluginToolActivationApi) {
          api.registerHook({ id: 'second', event: 'stop' }, () => {
            seen.push('second')
            return null
          })
          api.registerHook({ id: 'first', event: 'turnStart' }, (input, context) => {
            seen.push('first')
            assert.deepEqual(Object.keys(context).sort(), ['event', 'signal'])
            assert.equal(context.event, 'turnStart')
            assert.equal(context.signal, signal)
            return { received: input }
          })
          later = (): void => {
            api.registerHook({ id: 'late', event: 'stop' }, () => null)
          }
        },
      },
      'personal.hooks',
      1,
    )
    const signal = new AbortController().signal
    assert.deepEqual(
      activated.registrations.hooks?.map((h) => h.id),
      ['second', 'first'],
    )
    assert.deepEqual(
      await activated.invokeHook('first', 'turnStart', { userText: 'hello' }, signal),
      { received: { userText: 'hello' } },
    )
    assert.deepEqual(seen, ['first'])
    assert.throws(() => later?.(), /during activate/)
    await assert.rejects(activated.invokeHook('first', 'stop', {}, signal), /event mismatch/)
    await assert.rejects(activated.invokeHook('missing', 'stop', {}, signal), /Unknown plugin hook/)
    const aborted = AbortSignal.abort(new Error('cancelled'))
    await assert.rejects(activated.invokeHook('first', 'turnStart', {}, aborted), /cancelled/)
    assert.deepEqual(seen, ['first'])
  })

  it('rejects duplicate hook ids even when their events differ', async () => {
    await assert.rejects(
      activatePluginTools(
        {
          activate(api: PluginToolActivationApi) {
            api.registerHook({ id: 'same', event: 'turnStart' }, () => null)
            api.registerHook({ id: 'same', event: 'stop' }, () => null)
          },
        },
        'personal.hooks',
        1,
      ),
      /Duplicate plugin hook/,
    )
  })

  it('preserves API-v1 registrations and rejects invalid hook protocol fields', () => {
    assert.deepEqual(zPluginToolRegistrations.parse({ tools: [], models: [] }), {
      tools: [],
      models: [],
    })
    const request = { id: 1, op: 'invoke-hook', registrationId: 'h', event: 'turnStart', input: {} }
    assert.deepEqual(zPluginToolHostRequest.parse(request), request)
    for (const invalid of [
      { ...request, event: '*' },
      { ...request, next: 5 },
      { ...request, id: 0 },
    ]) {
      assert.equal(zPluginToolHostRequest.safeParse(invalid).success, false)
    }
    assert.equal(
      zPluginToolRegistrations.safeParse({
        tools: [],
        models: [],
        hooks: [{ id: 'a', event: 'bogus' }],
      }).success,
      false,
    )
  })
})
