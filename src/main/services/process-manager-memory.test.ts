import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ProcessManagerRow } from '@shared/types/process-manager.ts'
import { parseMacosFootprints, readProcessMemory } from './process-manager-memory.ts'

function row(pid: number, type: string): ProcessManagerRow {
  return {
    pid,
    startedAt: 100,
    label: type,
    type,
    threadId: type === 'Terminal' ? 'thread-a' : null,
    cpuPercent: 10,
    memoryMiB: 8,
  }
}

describe('process manager memory', () => {
  it('converts byte footprints to MiB, rejecting invalid helper output', () => {
    const output = `
  1 0
  2 1572864
  3 536870912
  4 1610612736
  5 1099511627776
  0 12
  6 -12
  7 N/A
  8 12X
  9 12 extra
  10 9007199254740992
`
    assert.deepEqual(
      [...parseMacosFootprints(output)],
      [
        [1, 0],
        [2, 1.5],
        [3, 512],
        [4, 1536],
        [5, 1048576],
      ],
    )
  })

  it('replaces RSS for app, graphics, terminal and command processes in one sample', async () => {
    const rows = [row(1, 'App'), row(2, 'Graphics'), row(3, 'Terminal'), row(4, 'Command')]
    const snapshot = await readProcessMemory(rows, 'darwin', async (pids) => {
      assert.deepEqual(pids, [1, 2, 3, 4])
      return parseMacosFootprints('1 12884901888\n2 536870912\n3 1073741824\n4 268435456')
    })
    assert.equal(snapshot.memoryMetric, 'footprint')
    assert.deepEqual(
      snapshot.processes.map((process) => process.memoryMiB),
      [12288, 512, 1024, 256],
    )
    assert.equal(
      snapshot.processes.reduce((sum, process) => sum + (process.memoryMiB ?? 0), 0),
      14080,
    )
    assert.deepEqual(snapshot.processes[2], { ...rows[2], memoryMiB: 1024 })
    assert.equal(rows[0]?.memoryMiB, 8, 'does not mutate source RSS samples')
  })

  it('marks inaccessible or exited processes unknown without mixing footprint and RSS', async () => {
    const snapshot = await readProcessMemory(
      [row(1, 'App'), row(2, 'Terminal')],
      'darwin',
      async () => new Map([[1, 0]]),
    )
    assert.deepEqual(
      snapshot.processes.map((process) => process.memoryMiB),
      [0, null],
    )
  })

  it('keeps the process list on timeout or denied sampling without reporting RSS as footprint', async () => {
    const snapshot = await readProcessMemory([row(1, 'App')], 'darwin', async () => {
      throw new Error('helper timed out or permission denied')
    })
    assert.equal(snapshot.memoryMetric, 'footprint')
    assert.deepEqual(snapshot.processes, [{ ...row(1, 'App'), memoryMiB: null }])
  })

  it('does not launch the helper for an empty process list or on other platforms', async () => {
    const neverRead = async (): Promise<ReadonlyMap<number, number>> => {
      assert.fail('must not invoke macOS sampler')
    }
    assert.deepEqual(await readProcessMemory([], 'darwin', neverRead), {
      memoryMetric: 'footprint',
      processes: [],
    })
    for (const platform of ['linux', 'win32'] satisfies NodeJS.Platform[]) {
      const rows = [row(1, 'App')]
      assert.deepEqual(await readProcessMemory(rows, platform, neverRead), {
        memoryMetric: 'resident',
        processes: rows,
      })
    }
  })
})
