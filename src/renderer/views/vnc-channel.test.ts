import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import { VncIpcChannel } from './vnc-channel.ts'

function apiHarness(): {
  api: Pick<ApiClient, 'vnc'>
  starts: string[]
  sends: Uint8Array[]
  closes: string[]
} {
  const starts: string[] = []
  const sends: Uint8Array[] = []
  const closes: string[] = []
  return {
    starts,
    sends,
    closes,
    api: {
      vnc: {
        open: (): Promise<never> => Promise.reject(new Error('unused')),
        list: (): Promise<never[]> => Promise.resolve([]),
        discover: (): Promise<never[]> => Promise.resolve([]),
        start: (id): void => {
          starts.push(id)
        },
        send: (_id, bytes): void => {
          sends.push(bytes)
        },
        close: (id): Promise<void> => {
          closes.push(id)
          return Promise.resolve()
        },
        onData: (): (() => void) => (): void => {},
        onStatus: (): (() => void) => (): void => {},
      },
    },
  }
}

describe('VncIpcChannel', () => {
  it('presents the WebSocket-shaped channel noVNC requires', () => {
    const harness = apiHarness()
    const channel = new VncIpcChannel('8f9d5aa0-b8ef-4e40-a9a6-5f4da50f0fa9', harness.api)
    let opened = false
    let message = ''
    channel.onopen = (): void => {
      opened = true
    }
    channel.onmessage = (event): void => {
      message = new TextDecoder().decode(event.data)
    }

    channel.open()
    channel.send(new TextEncoder().encode('client'))
    channel.receive(new TextEncoder().encode('server'))

    assert.equal(opened, true)
    assert.deepEqual(harness.starts, [channel.connectionId])
    assert.equal(new TextDecoder().decode(harness.sends[0]), 'client')
    assert.equal(message, 'server')
  })

  it('turns main-process error status into a failed close', () => {
    const harness = apiHarness()
    const channel = new VncIpcChannel('8f9d5aa0-b8ef-4e40-a9a6-5f4da50f0fa9', harness.api)
    let closeReason = ''
    channel.onclose = (event): void => {
      closeReason = event.reason
    }
    channel.open()
    channel.handleStatus({
      id: channel.connectionId,
      status: 'error',
      lastError: 'tunnel down',
    })

    assert.equal(channel.readyState, WebSocket.CLOSED)
    assert.equal(closeReason, 'tunnel down')
  })
})
