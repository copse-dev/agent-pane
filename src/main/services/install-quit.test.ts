import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InstallQuit, type QuitFlag } from './install-quit.ts'

function flag(initially = false): QuitFlag & { value: boolean } {
  const state = {
    value: initially,
    isSet: (): boolean => state.value,
    set: (): void => {
      state.value = true
    },
    clear: (): void => {
      state.value = false
    },
  }
  return state
}

describe('InstallQuit', () => {
  it('sets every flag before the updater quits', () => {
    const quitting = flag()
    const update = flag()
    const seen: boolean[] = []
    new InstallQuit([quitting, update]).start(() => {
      seen.push(quitting.value, update.value)
    })
    assert.deepEqual(seen, [true, true])
    assert.equal(quitting.value, true)
  })

  it('clears only the flags it set when the updater throws', () => {
    const quitting = flag(true)
    const update = flag()
    const quit = new InstallQuit([quitting, update])
    assert.throws(() => {
      quit.start(() => {
        throw new Error('no update')
      })
    })
    assert.equal(update.value, false)
    assert.equal(quitting.value, true)
  })

  it('clears its flags when the updater fails later', () => {
    const update = flag()
    const quit = new InstallQuit([update])
    quit.start(() => undefined)
    quit.abandon()
    assert.equal(update.value, false)
    quit.abandon()
    assert.equal(update.value, false)
  })
})
