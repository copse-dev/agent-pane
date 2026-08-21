import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BIN_MARKER,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  fromBase64,
  toBase64,
  type ClientFrame,
  type ServerFrame,
} from './ws-protocol.ts'

describe('Tauri WebSocket protocol', () => {
  it('round-trips undefined positional args like structured clone', () => {
    // Electron IPC preserves undefined optional args; plain JSON would turn
    // [path, undefined] into [path, null] and fail z.optional() guards.
    const frame = decodeClientFrame(
      encodeFrame({ t: 'invoke', id: 1, channel: 'workspace:set', args: ['/p', undefined] }),
    )
    if (frame.t !== 'invoke') throw new Error('wrong frame type')
    assert.equal(frame.args.length, 2)
    assert.equal(frame.args[0], '/p')
    assert.equal(frame.args[1], undefined)
    const event = decodeServerFrame(
      encodeFrame({ t: 'event', channel: 'x', args: [{ keep: 1, gone: undefined }] }),
    )
    if (event.t !== 'event') throw new Error('wrong frame type')
    assert.deepEqual(event.args[0], { keep: 1, gone: undefined })
  })

  it('round-trips client frames and nested binary values', () => {
    const frame: ClientFrame = {
      t: 'invoke',
      id: 7,
      channel: 'vnc:data',
      args: [{ chunk: new Uint8Array([0, 1, 127, 128, 255]) }],
    }

    assert.deepEqual(decodeClientFrame(encodeFrame(frame)), frame)
  })

  it('round-trips server results and events', () => {
    const result: ServerFrame = {
      t: 'result',
      id: 4,
      ok: true,
      value: { bytes: new Uint8Array([3, 2, 1]) },
    }
    const event: ServerFrame = {
      t: 'event',
      channel: 'attachment:loaded',
      args: [new Uint8Array([9, 8, 7])],
    }

    assert.deepEqual(decodeServerFrame(encodeFrame(result)), result)
    assert.deepEqual(decodeServerFrame(encodeFrame(event)), event)
  })

  it('keeps base64 conversion byte-exact across padding lengths', () => {
    for (const bytes of [
      new Uint8Array([]),
      new Uint8Array([1]),
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0, 127, 128, 255]),
    ]) {
      assert.deepEqual(fromBase64(toBase64(bytes)), bytes)
    }
  })

  it('rejects malformed or untrusted client frame shapes', () => {
    for (const text of [
      'null',
      '{}',
      '{"t":"hello","winId":1,"token":"short"}',
      '{"t":"invoke","id":-1,"channel":"settings:get","args":[]}',
      '{"t":"send","channel":"menu:open","args":"not-an-array"}',
      'not json',
    ]) {
      assert.throws(() => decodeClientFrame(text), /invalid client frame/)
    }
  })

  it('rejects malformed server frames and binary markers', () => {
    assert.throws(() => decodeServerFrame('{"t":"result","id":"4","ok":true}'))
    assert.throws(() =>
      decodeServerFrame(
        JSON.stringify({
          t: 'event',
          channel: 'vnc:data',
          args: [{ [BIN_MARKER]: 'not base64' }],
        }),
      ),
    )
  })
})
