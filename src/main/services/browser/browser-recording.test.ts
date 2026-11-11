import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  BrowserRecordingService,
  type RecordableContents,
  type RecordingDebugger,
} from './browser-recording.ts'

class FakeDebugger extends EventEmitter implements RecordingDebugger {
  attached = false
  commands: { method: string; params?: Record<string, unknown> }[] = []
  failStart = false

  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
  }
  detach(): void {
    this.attached = false
  }
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push(params === undefined ? { method } : { method, params })
    if (method === 'Page.startScreencast' && this.failStart) {
      return Promise.reject(new Error('Page domain unavailable'))
    }
    return Promise.resolve({})
  }
  emitFrame(data: string, sessionId: number): void {
    this.emit('message', {}, 'Page.screencastFrame', { data, sessionId, metadata: {} })
  }
}

class FakeContents extends EventEmitter implements RecordableContents {
  readonly id: number
  readonly debugger = new FakeDebugger()
  destroyed = false
  constructor(id: number) {
    super()
    this.id = id
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function harness(): {
  service: BrowserRecordingService
  frames: { id: number; bytes: string }[]
  ended: { id: number; reason: string }[]
} {
  const frames: { id: number; bytes: string }[] = []
  const ended: { id: number; reason: string }[] = []
  const service = new BrowserRecordingService({
    frame: (id, jpeg): void => {
      frames.push({ id, bytes: Buffer.from(jpeg).toString('utf8') })
    },
    ended: (id, reason): void => {
      ended.push({ id, reason })
    },
  })
  return { service, frames, ended }
}

describe('BrowserRecordingService', () => {
  it('starts a JPEG screencast and forwards each acknowledged frame as bytes', async () => {
    const { service, frames } = harness()
    const contents = new FakeContents(7)
    await service.start(contents)

    assert.equal(contents.debugger.attached, true)
    assert.deepEqual(contents.debugger.commands[0], {
      method: 'Page.startScreencast',
      params: { format: 'jpeg', quality: 80, maxWidth: 1600, maxHeight: 1600 },
    })

    contents.debugger.emitFrame(Buffer.from('frame-one').toString('base64'), 41)
    assert.deepEqual(frames, [{ id: 7, bytes: 'frame-one' }])
    assert.deepEqual(contents.debugger.commands[1], {
      method: 'Page.screencastFrameAck',
      params: { sessionId: 41 },
    })
  })

  it('ignores other protocol messages and malformed frames', async () => {
    const { service, frames } = harness()
    const contents = new FakeContents(1)
    await service.start(contents)
    contents.debugger.emit('message', {}, 'Network.requestWillBeSent', {})
    contents.debugger.emit('message', {}, 'Page.screencastFrame', { data: 42 })
    assert.deepEqual(frames, [])
  })

  it('stops the screencast and releases a debugger it attached', async () => {
    const { service, frames } = harness()
    const contents = new FakeContents(3)
    await service.start(contents)
    service.stop(3)

    assert.equal(service.isRecording(3), false)
    assert.ok(contents.debugger.commands.some((c) => c.method === 'Page.stopScreencast'))
    assert.equal(contents.debugger.attached, false)
    contents.debugger.emitFrame(Buffer.from('late').toString('base64'), 1)
    assert.deepEqual(frames, [])
  })

  it('leaves a debugger someone else attached in place', async () => {
    const { service } = harness()
    const contents = new FakeContents(4)
    contents.debugger.attached = true
    await service.start(contents)
    service.stop(4)
    assert.equal(contents.debugger.attached, true)
  })

  it('reports an unrequested end when the tab closes or the debugger detaches', async () => {
    const { service, ended } = harness()
    const closing = new FakeContents(5)
    const detaching = new FakeContents(6)
    await service.start(closing)
    await service.start(detaching)

    closing.destroy()
    detaching.debugger.emit('detach', {}, 'target closed')

    assert.deepEqual(ended, [
      { id: 5, reason: 'tab closed' },
      { id: 6, reason: 'target closed' },
    ])
    assert.equal(service.isRecording(5), false)
    assert.equal(service.isRecording(6), false)
  })

  it('does not report an end the caller asked for', async () => {
    const { service, ended } = harness()
    const contents = new FakeContents(8)
    await service.start(contents)
    service.stop(8)
    contents.destroy()
    assert.deepEqual(ended, [])
  })

  it('cleans up and rethrows when the screencast cannot start', async () => {
    const { service } = harness()
    const contents = new FakeContents(9)
    contents.debugger.failStart = true
    await assert.rejects(service.start(contents), /Page domain unavailable/)
    assert.equal(service.isRecording(9), false)
    assert.equal(contents.debugger.attached, false)
  })
})
