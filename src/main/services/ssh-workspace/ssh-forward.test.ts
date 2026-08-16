import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { allocateLoopbackPort, sshForwardControlArgs } from './ssh-forward.ts'

describe('SSH local forwarding', () => {
  it('binds both ends to loopback on the existing control socket', () => {
    assert.deepEqual(
      sshForwardControlArgs('/tmp/copse.sock', 'ubuntu@build-box', 'forward', {
        localPort: 43_210,
        remotePort: 5901,
      }),
      [
        '-S',
        '/tmp/copse.sock',
        '-O',
        'forward',
        '-L',
        '127.0.0.1:43210:127.0.0.1:5901',
        'ubuntu@build-box',
      ],
    )
  })

  it('uses the exact same forwarding spec when cancelling', () => {
    const args = sshForwardControlArgs('/tmp/copse.sock', 'build-box', 'cancel', {
      localPort: 43_211,
      remotePort: 3000,
    })
    assert.equal(args[3], 'cancel')
    assert.equal(args[5], '127.0.0.1:43211:127.0.0.1:3000')
  })

  it('allocates an available ephemeral loopback port', async () => {
    const port = await allocateLoopbackPort()
    assert.ok(port > 0 && port <= 65_535)
  })
})
