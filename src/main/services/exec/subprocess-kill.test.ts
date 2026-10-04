import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { terminateProcessTree, SUBPROCESS_KILL_GRACE_MS } from './subprocess-kill.ts'

describe('terminateProcessTree', () => {
  it('SIGTERMs a well-behaved process and cancels the pending SIGKILL', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX signal semantics')
      return
    }

    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: true,
    })
    await once(proc, 'spawn')

    const cancelKill = terminateProcessTree(proc, 1_000)
    const exit = await once(proc, 'exit')
    const code: unknown = exit[0]
    const signalName: unknown = exit[1]
    cancelKill()

    assert.equal(code, null)
    assert.equal(signalName, 'SIGTERM')
  })

  it('escalates to SIGKILL after the grace period when SIGTERM is ignored', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX signal semantics')
      return
    }

    // Trap SIGTERM so only SIGKILL can stop it; announce readiness so we don't
    // signal before the handler is installed (interpreter-startup race).
    const proc = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    )
    await once(proc.stdout, 'data')

    terminateProcessTree(proc, 100)
    const exit = await once(proc, 'exit')
    const code: unknown = exit[0]
    const signalName: unknown = exit[1]

    assert.equal(code, null)
    assert.equal(signalName, 'SIGKILL')
  })

  it('targets the process group so grandchildren are reaped (group leader detached)', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX process groups')
      return
    }

    // Parent sh spawns a sleeping grandchild then waits; both share the parent's
    // process group (pgid === parent pid) because it was spawned detached. A
    // group-targeted kill (negative pid) therefore reaches the grandchild too,
    // whereas killing only the direct child would orphan it.
    // Keep the leader alive to reap its child after SIGTERM. Otherwise PID 1 in
    // a container may retain the killed sleeper as a zombie indefinitely.
    const proc = spawn('/bin/sh', ['-c', "trap 'wait; exit 0' TERM; sleep 30 & echo $!; wait"], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    })
    await once(proc, 'spawn')

    const chunk: unknown = (await once(proc.stdout, 'data'))[0]
    assert.ok(Buffer.isBuffer(chunk))
    const grandchildPid = Number(chunk.toString().trim())
    assert.ok(grandchildPid > 0)

    // Sanity-check the precondition group kill relies on: the grandchild lives in
    // the detached child's process group.
    const pgidProbe = spawnSync('ps', ['-o', 'pgid=', '-p', String(grandchildPid)])
    const pgid = pgidProbe.error ? undefined : pgidProbe.stdout.toString().trim()
    const sameGroup = pgid ? Number(pgid) === proc.pid : null

    const cancelKill = terminateProcessTree(proc, SUBPROCESS_KILL_GRACE_MS)
    await once(proc, 'exit')
    cancelKill()

    let grandchildAlive = true
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        process.kill(grandchildPid, 0)
      } catch (error: unknown) {
        assert.ok(error instanceof Error)
        assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'ESRCH')
        grandchildAlive = false
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    // Always clean up before an assertion or environment-dependent skip. The
    // previous unchecked ps result could throw above and orphan this sleeper
    // for the full 30 seconds, compounding host resource pressure.
    if (grandchildAlive) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {
        /* best-effort cleanup */
      }
    }

    if (grandchildAlive && sameGroup === null) {
      t.skip(
        `could not inspect the grandchild process group: ${pgidProbe.error?.message ?? 'no output'}`,
      )
    } else {
      if (grandchildAlive)
        assert.ok(sameGroup, 'grandchild shares the detached child process group')
      assert.equal(grandchildAlive, false, 'grandchild reaped via process-group kill')
    }
  })
})
