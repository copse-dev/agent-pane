import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RemoteInterface } from './remote-interface.ts'
import { remoteHttp } from './remote-http.ts'

describe('paired remote HTTP boundary', () => {
  it('denies snapshots and reads without control before dispatch', async () => {
    const bridge = new RemoteInterface()
    let count = 0
    bridge.attach(() => {
      count++
    })
    assert.equal((await remoteHttp(bridge, () => false)).status, 403)
    assert.equal((await remoteHttp(bridge, () => false, '{}')).status, 403)
    assert.equal(count, 0)
  })

  it('returns a live snapshot and dispatches only validated reads', async () => {
    const bridge = new RemoteInterface()
    bridge.attach((id) => {
      bridge.reply({ id, ok: true, value: 'Try the release build.' })
    })
    bridge.publish({ projectId: 'p', threads: [] })
    assert.deepEqual((await remoteHttp(bridge, () => true)).body, bridge.snapshot())
    const request = JSON.stringify({ version: 1, channel: 'agent:suggest-next-step', args: ['{}'] })
    assert.deepEqual(await remoteHttp(bridge, () => true, request), {
      status: 200,
      body: { value: 'Try the release build.' },
    })
    assert.equal((await remoteHttp(bridge, () => true, '{"channel":"fs:read-file"}')).status, 400)
    assert.equal(
      (
        await remoteHttp(
          bridge,
          () => true,
          JSON.stringify({
            version: 1,
            channel: 'settings:get',
            args: ['anthropicApiKey'],
          }),
        )
      ).status,
      503,
    )
  })

  it('does not return an in-flight reply after device revocation', async () => {
    const bridge = new RemoteInterface()
    let id = ''
    let allowed = true
    bridge.attach((value) => {
      id = value
    })
    const pending = remoteHttp(
      bridge,
      () => allowed,
      JSON.stringify({
        version: 1,
        channel: 'settings:get',
        args: ['model'],
      }),
    )
    allowed = false
    bridge.reply({ id, ok: true, value: 'private' })
    assert.deepEqual(await pending, { status: 403, body: { error: 'Phone control was disabled.' } })
  })
})
