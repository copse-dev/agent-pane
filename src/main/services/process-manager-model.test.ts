import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildProcessSnapshot, type ProcessMetricSample } from './process-manager-model.ts'

function metric(pid: number, creationTime: number, cpuSeconds: number): ProcessMetricSample {
  return {
    pid,
    creationTime,
    type: 'Tab',
    cpu: { cumulativeCPUUsage: cpuSeconds, percentCPUUsage: 0 },
    memory: { workingSetSize: 153_600 },
  }
}

describe('process manager snapshots', () => {
  it('measures CPU across samples and converts memory KiB to MiB', () => {
    const labels = new Map([[42, 'Copse window']])
    const first = buildProcessSnapshot([metric(42, 100, 1)], labels, new Map(), 1_000)
    assert.deepEqual(first.snapshot.processes[0], {
      pid: 42,
      startedAt: 100,
      label: 'Copse window',
      type: 'Window',
      threadId: null,
      cpuPercent: null,
      memoryMiB: 150,
    })
    const second = buildProcessSnapshot([metric(42, 100, 1.5)], labels, first.samples, 2_000)
    const row = second.snapshot.processes[0]
    assert.ok(row)
    assert.equal(row.cpuPercent, 50)
  })

  it('drops exited processes and does not carry CPU across a reused PID', () => {
    const first = buildProcessSnapshot([metric(42, 100, 1)], new Map(), new Map(), 1_000)
    const second = buildProcessSnapshot([metric(42, 200, 0.1)], new Map(), first.samples, 2_000)
    assert.equal(second.snapshot.processes.length, 1)
    const row = second.snapshot.processes[0]
    assert.ok(row)
    assert.equal(row.startedAt, 200)
    assert.equal(row.cpuPercent, null)
    assert.equal(second.samples.size, 1)
  })

  it('uses interval usage when cumulative CPU time is unavailable', () => {
    const sample: ProcessMetricSample = {
      pid: 9,
      creationTime: 2,
      type: 'GPU',
      cpu: { percentCPUUsage: 15.5 },
      memory: { workingSetSize: 1024 },
    }
    const first = buildProcessSnapshot([sample], new Map(), new Map(), 1_000)
    const second = buildProcessSnapshot([sample], new Map(), first.samples, 2_000)
    const firstRow = first.snapshot.processes[0]
    const secondRow = second.snapshot.processes[0]
    assert.ok(firstRow)
    assert.ok(secondRow)
    assert.equal(firstRow.cpuPercent, null)
    assert.equal(secondRow.cpuPercent, 15.5)
  })
})
