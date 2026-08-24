import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createStdioGuard,
  installStdioGuard,
  isFatalStdioWriteError,
  isLogSinkAlive,
} from './stdio-guard.ts'

function errWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

describe('isFatalStdioWriteError', () => {
  it('recognises the codes a hung-up terminal produces', () => {
    for (const code of ['EIO', 'EPIPE', 'EBADF', 'ENXIO', 'ERR_STREAM_DESTROYED']) {
      assert.equal(isFatalStdioWriteError(errWithCode(code)), true, code)
    }
  })

  it('does not treat an ordinary error as a dead stream', () => {
    assert.equal(isFatalStdioWriteError(errWithCode('EAGAIN')), false)
    assert.equal(isFatalStdioWriteError(new Error('no code')), false)
    assert.equal(isFatalStdioWriteError('EIO'), false)
    assert.equal(isFatalStdioWriteError(null), false)
    assert.equal(isFatalStdioWriteError(undefined), false)
  })
})

describe('createStdioGuard', () => {
  it('swallows a stream error instead of letting it become an uncaught exception', () => {
    const stream = new EventEmitter()
    const guard = createStdioGuard([stream])
    try {
      // Without a listener, `emit('error')` throws — that is precisely how an
      // EIO write failure becomes an uncaught exception in the real process.
      assert.doesNotThrow(() => stream.emit('error', errWithCode('EIO')))
    } finally {
      guard.dispose()
    }
  })

  it('reports the sink dead only once every stream has failed fatally', () => {
    const out = new EventEmitter()
    const err = new EventEmitter()
    const guard = createStdioGuard([out, err])
    try {
      assert.equal(guard.isLogSinkAlive(), true)
      out.emit('error', errWithCode('EIO'))
      assert.equal(guard.isLogSinkAlive(), true, 'stderr is still writable')
      err.emit('error', errWithCode('EIO'))
      assert.equal(guard.isLogSinkAlive(), false)
      assert.equal(guard.deadStreamCount(), 2)
    } finally {
      guard.dispose()
    }
  })

  it('keeps the sink alive through a transient, non-fatal error', () => {
    const stream = new EventEmitter()
    const guard = createStdioGuard([stream])
    try {
      stream.emit('error', errWithCode('EAGAIN'))
      assert.equal(guard.isLogSinkAlive(), true)
      assert.equal(guard.deadStreamCount(), 0)
    } finally {
      guard.dispose()
    }
  })

  it('counts a stream once however many times it fails', () => {
    const stream = new EventEmitter()
    const guard = createStdioGuard([stream])
    try {
      for (let i = 0; i < 5; i++) stream.emit('error', errWithCode('EIO'))
      assert.equal(guard.deadStreamCount(), 1)
    } finally {
      guard.dispose()
    }
  })

  it('escalates the first fatal failure so a lost sink still ends the run', () => {
    const stream = new EventEmitter()
    const lost: unknown[] = []
    const guard = createStdioGuard([stream], {
      onSinkLost: (err) => {
        lost.push(err)
      },
    })
    try {
      const boom = errWithCode('EPIPE')
      stream.emit('error', boom)
      assert.deepEqual(lost, [boom], 'a dead ACP transport must not pass unnoticed')
    } finally {
      guard.dispose()
    }
  })

  it('escalates once, not once per failed write', () => {
    const out = new EventEmitter()
    const err = new EventEmitter()
    let lost = 0
    const guard = createStdioGuard([out, err], {
      onSinkLost: () => {
        lost++
      },
    })
    try {
      out.emit('error', errWithCode('EIO'))
      out.emit('error', errWithCode('EIO'))
      err.emit('error', errWithCode('EIO'))
      assert.equal(lost, 1, 'repeat quits re-enter before-quit mid-teardown')
    } finally {
      guard.dispose()
    }
  })

  it('does not escalate a transient error', () => {
    const stream = new EventEmitter()
    let lost = 0
    const guard = createStdioGuard([stream], {
      onSinkLost: () => {
        lost++
      },
    })
    try {
      stream.emit('error', errWithCode('EAGAIN'))
      assert.equal(lost, 0)
    } finally {
      guard.dispose()
    }
  })

  it('removes its listeners on dispose', () => {
    const stream = new EventEmitter()
    const guard = createStdioGuard([stream])
    assert.equal(stream.listenerCount('error'), 1)
    guard.dispose()
    assert.equal(stream.listenerCount('error'), 0)
  })
})

describe('installStdioGuard', () => {
  it('is idempotent and restores the listener count on dispose', () => {
    const before = process.stdout.listenerCount('error')
    const first = installStdioGuard()
    const second = installStdioGuard()
    try {
      assert.equal(process.stdout.listenerCount('error'), before + 1)
    } finally {
      second()
      first()
    }
    assert.equal(process.stdout.listenerCount('error'), before)
  })

  it('assumes an uninstrumented process can still log', () => {
    assert.equal(isLogSinkAlive(), true)
  })
})
