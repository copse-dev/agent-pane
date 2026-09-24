import type { ProcessManagerSnapshot } from '@shared/types/process-manager.ts'

export interface ProcessMetricSample {
  pid: number
  creationTime: number
  type: string
  name?: string
  cpu: { cumulativeCPUUsage?: number; percentCPUUsage: number }
  memory: { workingSetSize: number }
}

export interface CpuSample {
  at: number
  seconds: number | null
}

/** Use PID and creation time together: the OS may reuse a PID after a process exits. */
export function processKey(metric: ProcessMetricSample): string {
  return `${String(metric.pid)}:${String(metric.creationTime)}`
}

function processLabel(metric: ProcessMetricSample, labels: ReadonlyMap<number, string>): string {
  const known = labels.get(metric.pid)
  if (known) return known
  if (metric.type === 'Browser') return 'Copse main'
  const name = metric.name?.trim()
  if (name) return name
  return metric.type === 'Tab' ? 'Copse window' : 'Copse service'
}

function processType(type: string): string {
  switch (type) {
    case 'Browser':
      return 'App'
    case 'Tab':
      return 'Window'
    case 'GPU':
      return 'Graphics'
    case 'Utility':
      return 'Service'
    default:
      return 'Helper'
  }
}

export function buildProcessSnapshot(
  metrics: readonly ProcessMetricSample[],
  labels: ReadonlyMap<number, string>,
  previous: ReadonlyMap<string, CpuSample>,
  sampledAt: number,
): { snapshot: ProcessManagerSnapshot; samples: Map<string, CpuSample> } {
  const samples = new Map<string, CpuSample>()
  const processes = metrics.map((metric) => {
    const key = processKey(metric)
    const seconds = metric.cpu.cumulativeCPUUsage
    const prior = previous.get(key)
    let cpuPercent: number | null = null
    if (seconds !== undefined && Number.isFinite(seconds)) {
      samples.set(key, { at: sampledAt, seconds })
      if (prior && prior.seconds !== null && sampledAt > prior.at && seconds >= prior.seconds) {
        cpuPercent = ((seconds - prior.seconds) * 100_000) / (sampledAt - prior.at)
      }
    } else {
      samples.set(key, { at: sampledAt, seconds: null })
      if (prior && Number.isFinite(metric.cpu.percentCPUUsage)) {
        cpuPercent = metric.cpu.percentCPUUsage
      }
    }

    return {
      pid: metric.pid,
      startedAt: metric.creationTime,
      label: processLabel(metric, labels),
      type: processType(metric.type),
      threadId: null,
      cpuPercent: cpuPercent === null ? null : Math.round(Math.max(0, cpuPercent) * 10) / 10,
      memoryMiB: Math.round((metric.memory.workingSetSize / 1024) * 10) / 10,
    }
  })
  return { snapshot: { sampledAt, processes }, samples }
}
