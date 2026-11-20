import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { runShellOnce } from './foreground-shell-process.ts'
import {
  emitShellOutput,
  mirrorShellOutput,
  runWithShellTaskId,
  setShellOutputSink,
} from './shell-output-context.ts'

interface Mirrored {
  chunk: string
  taskId: string | null
}

describe('shell output task attribution', () => {
  let root: string
  let mirrored: Mirrored[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-shell-output-'))
    mirrored = []
    setShellOutputSink((chunk, taskId) => {
      mirrored.push({ chunk, taskId })
    })
  })
  afterEach(() => {
    setShellOutputSink(null)
    rmSync(root, { recursive: true, force: true })
  })

  /** The task ids each marker word was mirrored under. */
  function taskIdsFor(marker: string): (string | null)[] {
    return mirrored.filter((entry) => entry.chunk.includes(marker)).map((entry) => entry.taskId)
  }

  it('stamps output with the id of the scope it was emitted in', async () => {
    mirrorShellOutput('outside')
    runWithShellTaskId('call-1', () => {
      emitShellOutput('inside-sync')
    })
    await runWithShellTaskId('call-2', async () => {
      await new Promise((resolve) => setImmediate(resolve))
      mirrorShellOutput('inside-async')
    })
    mirrorShellOutput('after')

    assert.deepEqual(mirrored, [
      { chunk: 'outside', taskId: null },
      { chunk: 'inside-sync', taskId: 'call-1' },
      { chunk: 'inside-async', taskId: 'call-2' },
      { chunk: 'after', taskId: null },
    ])
  })

  it('keeps interleaved scopes on their own ids, whichever finishes first', async () => {
    let releaseA: () => void = () => {}
    let releaseB: () => void = () => {}
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))
    const gateB = new Promise<void>((resolve) => (releaseB = resolve))
    const first = runWithShellTaskId('call-a', async () => {
      mirrorShellOutput('a-early')
      await gateA
      mirrorShellOutput('a-late')
    })
    const second = runWithShellTaskId('call-b', async () => {
      mirrorShellOutput('b-early')
      await gateB
      mirrorShellOutput('b-late')
    })
    // B started last; A must not pick up its id. A ends first; B must keep its.
    releaseA()
    await first
    releaseB()
    await second

    assert.deepEqual(mirrored, [
      { chunk: 'a-early', taskId: 'call-a' },
      { chunk: 'b-early', taskId: 'call-b' },
      { chunk: 'a-late', taskId: 'call-a' },
      { chunk: 'b-late', taskId: 'call-b' },
    ])
  })

  it('keeps two overlapping run_shell processes on their own ids', async () => {
    const run = (taskId: string, command: string): Promise<unknown> =>
      runWithShellTaskId(taskId, () =>
        runShellOnce(command, root, 10_000, new AbortController().signal, true, process.env),
      )

    // A starts first and finishes first; B starts while A runs and prints again
    // after A has finished. A shared slot stamped A's later output with B's id
    // and left B's last line with none.
    const first = run('call-a', 'echo a-early; sleep 0.4; echo a-late')
    const second = run('call-b', 'sleep 0.15; echo b-early; sleep 0.6; echo b-late')
    await Promise.all([first, second])

    assert.deepEqual(taskIdsFor('a-early'), ['call-a'])
    assert.deepEqual(taskIdsFor('a-late'), ['call-a'])
    assert.deepEqual(taskIdsFor('b-early'), ['call-b'])
    assert.deepEqual(taskIdsFor('b-late'), ['call-b'])
    // Nothing leaks out of either call once both have returned.
    mirrorShellOutput('idle')
    assert.deepEqual(taskIdsFor('idle'), [null])
  })
})
