import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CaptureHandleRegistry,
  type BrowserCaptureInput,
  type BrowserCaptureSource,
} from './capture-handle-store.ts'

const OWNER = { projectId: 'project-a', threadId: 'thread-a' }
const OTHER_THREAD = { projectId: 'project-a', threadId: 'thread-b' }

function capture(bytes: Uint8Array): BrowserCaptureInput {
  const source = {
    kind: 'browser',
    viewId: 'tab-1',
    title: 'Preview',
    url: 'http://localhost:3000/',
  } satisfies BrowserCaptureSource
  return {
    source,
    capturedAt: 1_000,
    width: 1280,
    height: 800,
    bytes,
  }
}

describe('CaptureHandleRegistry', () => {
  it('resolves retained pixels only for the thread that created the handle', () => {
    const registry = new CaptureHandleRegistry({ createId: (): string => 'one' })
    const input = Buffer.from('pixels')
    const handle = registry.create(OWNER, capture(input))

    input.fill(0)
    assert.equal(handle.id, 'capture_one')
    assert.equal(handle.kind, 'screenshot')
    assert.equal(handle.sizeBytes, 6)
    assert.equal(registry.resolve(handle.id, OTHER_THREAD), null)
    assert.equal(registry.resolve(handle.id, { ...OWNER, projectId: 'project-b' }), null)

    const resolved = registry.resolve(handle.id, OWNER)
    assert.ok(resolved)
    assert.equal(resolved.bytes.toString(), 'pixels')
    resolved.bytes.fill(0)
    assert.equal(registry.resolve(handle.id, OWNER)?.bytes.toString(), 'pixels')
  })

  it('expires a handle without leaving its pixels resolvable', () => {
    let now = 10
    const registry = new CaptureHandleRegistry({
      ttlMs: 50,
      now: (): number => now,
      createId: (): string => 'expiring',
    })
    const handle = registry.create(OWNER, capture(Buffer.from('pixels')))

    now = 59
    assert.ok(registry.resolve(handle.id, OWNER))
    now = 60
    assert.equal(registry.resolve(handle.id, OWNER), null)
  })

  it('evicts the oldest capture to stay within its entry and byte budgets', () => {
    let id = 0
    const registry = new CaptureHandleRegistry({
      maxCaptureBytes: 4,
      maxStoreBytes: 6,
      maxEntries: 2,
      createId: (): string => String(++id),
    })
    const first = registry.create(OWNER, capture(Buffer.from('aaa')))
    const second = registry.create(OWNER, capture(Buffer.from('bbb')))
    const third = registry.create(OWNER, capture(Buffer.from('ccc')))

    assert.equal(registry.resolve(first.id, OWNER), null)
    assert.ok(registry.resolve(second.id, OWNER))
    assert.ok(registry.resolve(third.id, OWNER))
    assert.throws(
      () => registry.create(OWNER, capture(Buffer.from('large'))),
      /over the 4 byte capture limit/,
    )
  })

  it('refuses an identifier collision instead of corrupting byte accounting', () => {
    const registry = new CaptureHandleRegistry({ createId: (): string => 'same' })
    registry.create(OWNER, capture(Buffer.from('first')))
    assert.throws(
      () => registry.create(OWNER, capture(Buffer.from('second'))),
      /handle ID collision/,
    )
  })
})
