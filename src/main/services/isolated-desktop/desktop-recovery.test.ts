import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DESKTOP_LEASE_LABEL,
  DesktopLeaseRecovery,
  deleteDesktopContainer,
} from './desktop-recovery.ts'

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

it('counts a VM deleted by a timed-out command as deleted, and nothing else', async () => {
  const name = 'copse-desktop-probe-' + randomUUID()
  const failure = (stderr: string): Error => Object.assign(new Error('Command failed'), { stderr })
  const missing = failure(`Error: notFound: "container with ID ${name} not found"`)
  const scripted = (
    ...outcomes: (Error | undefined)[]
  ): { calls: string[][]; run: (args: string[]) => Promise<void> } => {
    const calls: string[][] = []
    const run = (args: string[]): Promise<void> => {
      calls.push(args)
      const outcome = outcomes.shift()
      return outcome ? Promise.reject(outcome) : Promise.resolve()
    }
    return { calls, run }
  }

  // The engine finished the deletion the timed-out command asked for.
  const timedOut = scripted(Object.assign(new Error('Command failed'), { killed: true }), missing)
  await deleteDesktopContainer(name, timedOut.run)
  assert.deepEqual(timedOut.calls, [
    ['delete', '--force', name],
    ['delete', '--force', name],
  ])

  const gone = scripted(missing)
  await deleteDesktopContainer(name, gone.run)
  assert.equal(gone.calls.length, 1)

  // Another container's absence, or a second real failure, is never success,
  // and the error names both attempts' causes.
  const busy = failure('engine busy')
  const other = failure('Error: notFound: "container with ID copse-desktop-probe-other not found"')
  const failing = scripted(busy, other)
  await assert.rejects(deleteDesktopContainer(name, failing.run), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [busy, other])
    return true
  })
  assert.equal(failing.calls.length, 2)

  // A command killed at its limit says so; Node's own message does not.
  const killed = (): Error => Object.assign(new Error('Command failed'), { killed: true })
  const stuck = scripted(killed(), killed())
  await assert.rejects(deleteDesktopContainer(name, stuck.run), {
    message: 'VM deletion failed twice: container delete timed out; container delete timed out',
  })
  await assert.rejects(deleteDesktopContainer('not-a-desktop', gone.run))
})
