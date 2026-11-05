import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DESKTOP_LEASE_LABEL, DesktopLeaseRecovery } from './desktop-recovery.ts'

it('reclaims only dead or expired owned desktops, retaining failed deletion for retry', async () => {
  await mkdir('.tmp', { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/desktop-recovery-'))
  const state = { now: 1000, alive: true, fail: true }
  const removed: string[] = []
  const name = 'copse-desktop-probe-' + randomUUID()
  let nonce = ''
  const recovery = new DesktopLeaseRecovery(
    directory,
    {
      inspect: (): Promise<string | null> =>
        Promise.resolve(
          JSON.stringify([
            {
              configuration: { labels: { [DESKTOP_LEASE_LABEL]: nonce } },
            },
          ]),
        ),
      remove: (id): Promise<void> => {
        if (state.fail) return Promise.reject(new Error('engine deletion failed'))
        removed.push(id)
        return Promise.resolve()
      },
    },
    { pid: 123, now: (): number => state.now, isAlive: (): boolean => state.alive },
  )
  try {
    nonce = await recovery.begin(name)
    await recovery.recover()
    assert.deepEqual(removed, [])
    state.alive = false
    await assert.rejects(recovery.recover(), /engine deletion failed/)
    assert.equal((await readdir(directory)).length, 1)
    state.fail = false
    await recovery.recover()
    assert.deepEqual(removed, [name])
    assert.deepEqual(await readdir(directory), [])
    nonce = await recovery.begin(name)
    state.alive = true
    state.now += 15 * 60_000
    await recovery.recover()
    assert.deepEqual(removed, [name, name])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('refuses a name collision with a different VM and forgets an explicit missing VM', async () => {
  await mkdir('.tmp', { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/desktop-recovery-'))
  const state = { missing: false }
  const name = 'copse-desktop-probe-' + randomUUID()
  const recovery = new DesktopLeaseRecovery(
    directory,
    {
      inspect: (): Promise<string | null> =>
        Promise.resolve(
          state.missing
            ? null
            : JSON.stringify([
                {
                  configuration: { labels: { [DESKTOP_LEASE_LABEL]: randomUUID() } },
                },
              ]),
        ),
      remove: (): Promise<void> => {
        throw new Error('Must not delete another VM')
      },
    },
    { pid: 123, now: (): number => 1000, isAlive: (): boolean => false },
  )
  try {
    await recovery.begin(name)
    await assert.rejects(recovery.recover(), /mismatched recovery ownership/)
    assert.equal((await readdir(directory)).length, 1)
    state.missing = true
    await recovery.recover()
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
