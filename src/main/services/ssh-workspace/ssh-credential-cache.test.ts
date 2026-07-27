// Pins the session-secret cache behind the askpass bridge: one dialog per
// prompt for the whole app session, one dialog (not N) when a burst of `ssh`
// invocations races the ControlMaster socket, and an automatic re-prompt when
// OpenSSH signals a rejected secret by asking the same client twice.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearSshCredentialCache,
  releaseSshCredentialNonce,
  resolveSshSecret,
} from './ssh-credential-cache.ts'

const PROMPT = '(me@dev.example) Password:'

/** An `ask` that records how many times the modal would have been raised. */
function asker(
  values: string[],
  remember = true,
): { ask: () => Promise<{ value: string; remember: boolean }>; calls: () => number } {
  let calls = 0
  return {
    ask: (): Promise<{ value: string; remember: boolean }> => {
      const value = values[Math.min(calls, values.length - 1)] ?? ''
      calls += 1
      return Promise.resolve({ value, remember })
    },
    calls: () => calls,
  }
}

describe('resolveSshSecret', () => {
  beforeEach(() => {
    clearSshCredentialCache()
  })

  it('prompts once and replays the answer to later spawns', async () => {
    const { ask, calls } = asker(['hunter2'])

    assert.equal(await resolveSshSecret('nonce-a', PROMPT, ask), 'hunter2')
    releaseSshCredentialNonce('nonce-a')
    assert.equal(await resolveSshSecret('nonce-b', PROMPT, ask), 'hunter2')
    assert.equal(await resolveSshSecret('nonce-c', PROMPT, ask), 'hunter2')

    assert.equal(calls(), 1)
  })

  it('raises a single dialog for concurrent asks racing the control master', async () => {
    let release = (): void => {}
    let calls = 0
    const ask = (): Promise<{ value: string; remember: boolean }> => {
      calls += 1
      return new Promise((resolve) => {
        release = (): void => {
          resolve({ value: 'hunter2', remember: true })
        }
      })
    }

    const results = Promise.all([
      resolveSshSecret('nonce-1', PROMPT, ask),
      resolveSshSecret('nonce-2', PROMPT, ask),
      resolveSshSecret('nonce-3', PROMPT, ask),
    ])
    release()

    assert.deepEqual(await results, ['hunter2', 'hunter2', 'hunter2'])
    assert.equal(calls, 1)
  })

  it('re-prompts when the same spawn asks again (rejected secret)', async () => {
    const { ask, calls } = asker(['wrong', 'right'])

    assert.equal(await resolveSshSecret('nonce-a', PROMPT, ask), 'wrong')
    // OpenSSH re-execs askpass for the next attempt on the same client.
    assert.equal(await resolveSshSecret('nonce-a', PROMPT, ask), 'right')
    assert.equal(calls(), 2)

    // The bad secret is gone; a fresh spawn gets the corrected one.
    assert.equal(await resolveSshSecret('nonce-b', PROMPT, ask), 'right')
    assert.equal(calls(), 2)
  })

  it('does not double-prompt when two spawns hold the same rejected secret', async () => {
    const { ask, calls } = asker(['wrong', 'right'])

    await resolveSshSecret('nonce-1', PROMPT, ask)
    await resolveSshSecret('nonce-2', PROMPT, ask)
    assert.equal(calls(), 1)

    const retries = Promise.all([
      resolveSshSecret('nonce-1', PROMPT, ask),
      resolveSshSecret('nonce-2', PROMPT, ask),
    ])
    assert.deepEqual(await retries, ['right', 'right'])
    assert.equal(calls(), 2)
  })

  it('keeps distinct hosts on separate entries', async () => {
    const { ask, calls } = asker(['first'])
    await resolveSshSecret('nonce-a', '(me@one.example) Password:', ask)
    await resolveSshSecret('nonce-b', '(me@two.example) Password:', ask)
    assert.equal(calls(), 2)
  })

  it('honors an opt-out and prompts again next time', async () => {
    const { ask, calls } = asker(['once'], false)

    assert.equal(await resolveSshSecret('nonce-a', PROMPT, ask), 'once')
    releaseSshCredentialNonce('nonce-a')
    assert.equal(await resolveSshSecret('nonce-b', PROMPT, ask), 'once')

    assert.equal(calls(), 2)
  })

  it('never caches an empty answer (cancelled dialog)', async () => {
    const { ask, calls } = asker(['', 'later'])

    assert.equal(await resolveSshSecret('nonce-a', PROMPT, ask), '')
    releaseSshCredentialNonce('nonce-a')
    assert.equal(await resolveSshSecret('nonce-b', PROMPT, ask), 'later')

    assert.equal(calls(), 2)
  })

  it('forgets everything on clear', async () => {
    const { ask, calls } = asker(['hunter2'])
    await resolveSshSecret('nonce-a', PROMPT, ask)
    clearSshCredentialCache()
    await resolveSshSecret('nonce-b', PROMPT, ask)
    assert.equal(calls(), 2)
  })
})
