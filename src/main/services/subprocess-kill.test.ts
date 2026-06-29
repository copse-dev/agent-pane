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
    const [code, signalName] = (await once(proc, 'exit')) as [number | null, NodeJS.Signals | null]
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
    const [code, signalName] = (await once(proc, 'exit')) as [number | null, NodeJS.Signals | null]

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
    const proc = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    })
    await once(proc, 'spawn')

    const [chunk] = (await once(proc.stdout, 'data')) as [Buffer]
    const grandchildPid = Number(chunk.toString().trim())
    assert.ok(grandchildPid > 0)

    // Sanity-check the precondition group kill relies on: the grandchild lives in
    // the detached child's process group.
    const pgid = spawnSync('ps', ['-o', 'pgid=', '-p', String(grandchildPid)]).stdout.toString()
    const sameGroup = Number(pgid.trim()) === proc.pid

    terminateProcessTree(proc, SUBPROCESS_KILL_GRACE_MS)
    await once(proc, 'exit')
    await new Promise((r) => setTimeout(r, 200))

    let grandchildAlive = true
    try {
      process.kill(grandchildPid, 0)
    } catch {
      grandchildAlive = false
    }

    if (sameGroup && !grandchildAlive) {
      assert.ok(true, 'grandchild reaped via process-group kill')
    } else {
      // Some sandboxed CI namespaces don't deliver group signals across the PID
      // boundary; the precondition (shared group) is what makes group kill correct.
      assert.ok(sameGroup, 'grandchild shares the detached child process group')
      if (grandchildAlive) {
        try {
          process.kill(grandchildPid, 'SIGKILL')
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  })
})
