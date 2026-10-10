import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseShutdownGroup,
  ProcessMemoryHistory,
  summarizeProcessMemory,
} from './process-memory.ts'
import type { ProcessManagerRow } from '@shared/types/process-manager.ts'

function row(pid: number, memoryMiB: number | null, threadId: string | null): ProcessManagerRow {
  return {
    pid,
    memoryMiB,
    threadId,
    startedAt: 0,
    label: 'secret command',
    type: 'Command',
    cpuPercent: null,
  }
}

describe('process memory diagnostics', () => {
  it('writes one reusable report only from the sampler-owning process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copse-memory-'))
    const output = join(directory, 'report.json')
    const source = stripTypeScriptTypes(
      await readFile(
        join(process.cwd(), 'src/main/services/diagnostics/process-memory.ts'),
        'utf8',
      ),
    )
    const run = promisify(execFile)
    const launch = async (operation: string): Promise<void> => {
      await run(process.execPath, ['--input-type=module', '-e', source + '\n' + operation], {
        env: { ...process.env, COPSE_DEBUG_PROCESS_MEMORY_OUT: output },
      })
    }
    try {
      await launch(
        'observeProcessShutdown(12345, 0); await new Promise(resolve => setTimeout(resolve, 100));',
      )
      assert.deepEqual(await readdir(directory), [])
      const sample =
        'startProcessMemoryDiagnostics(async () => ({sampledAt: Date.now(), processes: []})); await new Promise(resolve => setTimeout(resolve, 200));'
      await launch(sample)
      await launch(sample)
      assert.deepEqual(await readdir(directory), ['report.json'])
      assert.match(await readFile(output, 'utf8'), /"samples":\[\{/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('deduplicates PIDs, reports missing measurements and excludes command text', () => {
    const point = summarizeProcessMemory({
      sampledAt: 1,
      processes: [row(1, 100, 't'), row(1, 100, 't'), row(2, 20, null), row(3, null, 't')],
    })
    assert.equal(point.memoryMiB, 120)
    assert.equal(point.sharedMemoryMiB, 20)
    assert.equal(point.processCount, 3)
    assert.equal(point.measuredProcessCount, 2)
    assert.equal(point.threadCount, 1)
    assert.equal(JSON.stringify(point).includes('secret command'), false)
  })

  it('bounds history, recording at most once every fifteen seconds', () => {
    const history = new ProcessMemoryHistory()
    for (let index = 0; index < 130; index++) {
      history.record({ sampledAt: index * 15_000, processes: [row(1, index, null)] })
      history.record({ sampledAt: index * 15_000 + 1, processes: [] })
      history.shutdown({ sampledAt: index, rootPid: 1, status: 'sampled', survivors: [] })
    }
    assert.equal(history.samples.length, 120)
    assert.equal(history.samples[0]?.sampledAt, 150_000)
    assert.equal(history.shutdowns.length, 32)
    assert.equal(history.shutdowns[0]?.sampledAt, 98)
  })

  it('bounds largest-process detail even for large process trees', () => {
    const point = summarizeProcessMemory({
      sampledAt: 1,
      processes: Array.from({ length: 200 }, (_, index) => row(index, index, null)),
    })
    assert.equal(point.largest.length, 20)
    assert.equal(point.largest[0]?.pid, 199)
  })

  it('reports no survivors for a drained group or empty process table', () => {
    assert.deepEqual(parseShutdownGroup('', 10), [])
    assert.deepEqual(parseShutdownGroup(' 31 10 0 Z\n 32 20 4096 S\n', 10), [])
  })

  it('preserves unavailable measurements instead of implying zero measured memory', () => {
    const point = summarizeProcessMemory({ sampledAt: 1, processes: [row(1, null, null)] })
    assert.equal(point.processCount, 1)
    assert.equal(point.measuredProcessCount, 0)
    assert.deepEqual(point.largest, [])
  })

  it('finds living descendants in the original group after the leader exits, excluding zombies', () => {
    const output = ' 30 10 2048 S\n 31 10 0 Z\n 32 20 4096 S\n malformed\n'
    assert.deepEqual(parseShutdownGroup(output, 10), [{ pid: 30, memoryMiB: 2 }])
  })
})
