import type { ProcessManagerRow, ProcessManagerSnapshot } from '@shared/types/process-manager.ts'
import {
  buildProcessSnapshot,
  type CpuSample,
  type ProcessMetricSample,
} from './process-manager-model.ts'

const CACHE_MS = 850

/** A single sampler shared by every window; platform adapters supply the process data. */
export function createProcessManagerSampler(
  readMetrics: () => readonly ProcessMetricSample[],
  readLabels: () => ReadonlyMap<number, string>,
  readOwnedRows: (appPids: ReadonlySet<number>) => Promise<ProcessManagerRow[]>,
  readActiveRunThreadIds: () => string[],
): () => Promise<ProcessManagerSnapshot> {
  let cached: ProcessManagerSnapshot | null = null
  let pending: Promise<ProcessManagerSnapshot> | null = null
  let samples = new Map<string, CpuSample>()

  return () => {
    const now = Date.now()
    if (cached && now - cached.sampledAt < CACHE_MS) return Promise.resolve(cached)
    if (pending) return pending
    const metrics = readMetrics()
    const result = buildProcessSnapshot(metrics, readLabels(), samples, now)
    samples = result.samples
    pending = readOwnedRows(new Set(metrics.map((metric) => metric.pid)))
      .then((owned) => {
        cached = {
          sampledAt: now,
          processes: [...result.snapshot.processes, ...owned],
          activeRunThreadIds: readActiveRunThreadIds(),
        }
        return cached
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
}
