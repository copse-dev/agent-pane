import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { DesktopTransport } from './desktop-session.ts'
import {
  admitIsolatedDesktop,
  controlIsolatedDesktop,
  stopAllIsolatedDesktops,
  stopIsolatedDesktopsForThread,
} from './desktop-service.ts'

/** A guest that boots at once and acknowledges every input. */
function guest(): { transport: DesktopTransport; readonly removed: number } {
  let removed = 0
  let emit: (line: string) => void = () => {}
  const transport: DesktopTransport = {
    start(onLine) {
      emit = onLine
      queueMicrotask(() => {
        emit(JSON.stringify({ event: 'ready', title: 'Copse', width: 1280, height: 800 }))
      })
      return Promise.resolve()
    },
    send() {
      queueMicrotask(() => {
        emit(JSON.stringify({ event: 'input-complete' }))
      })
      return Promise.resolve()
    },
    remove() {
      removed++
      return Promise.resolve()
    },
    revoke() {},
  }
  return {
    transport,
    get removed(): number {
      return removed
    },
  }
}

const owner = { projectId: 'project', threadId: 'thread' }

describe('isolated desktop grant lifetime', () => {
  afterEach(async () => {
    await stopAllIsolatedDesktops()
  })

  it('outlives the starting call and its turn until the thread is stopped', async () => {
    const vm = guest()
    // The starting call ends (its HTTP response closes, its turn finishes) once start returns.
    const call = new AbortController()
    await admitIsolatedDesktop(owner, vm.transport, call.signal)
    // Startup cancellation would revoke synchronously on abort; let any listener run.
    call.abort()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(vm.removed, 0)
    // A later turn of the same thread still controls it, with no second consent.
    assert.equal(await controlIsolatedDesktop(owner, { action: 'key', key: 'Tab' }), undefined)

    const other = guest()
    const otherOwner = { projectId: 'project', threadId: 'other' }
    await admitIsolatedDesktop(otherOwner, other.transport, new AbortController().signal)
    await stopIsolatedDesktopsForThread(owner.threadId)
    assert.equal(vm.removed, 1)
    await assert.rejects(controlIsolatedDesktop(owner, { action: 'screenshot' }), /no isolated/)
    // Another thread's grant is untouched.
    assert.equal(other.removed, 0)
    assert.equal(await controlIsolatedDesktop(otherOwner, { action: 'key', key: 'Tab' }), undefined)
  })

  it('still cancels a startup whose call is abandoned before the guest is ready', async () => {
    const vm = guest()
    const call = new AbortController()
    call.abort()
    await assert.rejects(admitIsolatedDesktop(owner, vm.transport, call.signal))
    assert.equal(vm.removed, 1)
    await assert.rejects(controlIsolatedDesktop(owner, { action: 'screenshot' }), /no isolated/)
  })
})
