import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * Guards `patches/when-exit@2.1.5.patch`.
 *
 * Main loads electron-store -> conf -> atomically -> when-exit, and when-exit
 * hooks a list of signals as soon as it loads. A JS listener on a signal makes
 * libuv install a C handler that queues the signal and returns. For a signal
 * the kernel raises in the thread that faulted, returning puts the thread back
 * on the faulting instruction before any JS can run. After Chromium's arm64
 * `brk #0` (CHECK failures, PartitionAlloc OOM) that is a livelock: main spun
 * at 100% CPU for minutes instead of crashing and writing a crash report.
 *
 * With no listener the signal keeps its default action, so the process dies
 * and Crashpad or the OS records the crash.
 */
const FAULT_SIGNALS = [
  'SIGTRAP',
  'SIGABRT',
  'SIGIOT',
  'SIGSYS',
  'SIGBUS',
  'SIGSEGV',
  'SIGILL',
  'SIGFPE',
] as const satisfies readonly NodeJS.Signals[]

/** What atomically's temp-file cleanup still relies on when-exit for. */
const CLEANUP_EVENTS = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const

function listenerCounts(events: readonly string[]): Record<string, number> {
  return Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]))
}

describe('main-process signal listeners', () => {
  it('loading the electron-store backend hooks no native fault signal', async () => {
    const cleanupBefore = listenerCounts(CLEANUP_EVENTS)
    // Imported here, not at the top, so the counts above are from before
    // when-exit loaded.
    const { installElectronStoreBackend } = await import('./electron-store-backend.ts')
    assert.equal(typeof installElectronStoreBackend, 'function')

    // when-exit really loaded and still hooks what the cleanup needs, so the
    // assertion below cannot pass because the hook never ran.
    assert.deepEqual(
      listenerCounts(CLEANUP_EVENTS),
      Object.fromEntries(CLEANUP_EVENTS.map((event) => [event, (cleanupBefore[event] ?? 0) + 1])),
    )
    assert.deepEqual(
      listenerCounts(FAULT_SIGNALS),
      Object.fromEntries(FAULT_SIGNALS.map((signal) => [signal, 0])),
      'a listener on a fault signal turns a native trap in main into a livelock',
    )
  })
})
