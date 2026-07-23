import rawDescriptor from '../../benchmarks/terminal_bench/datasets/terminal-bench-2.1.json' with { type: 'json' }

export interface TerminalBenchTaskMetadata {
  name: string
  image: string
  configSha256: string
}

export interface TerminalBenchDatasetDescriptor {
  schemaVersion: 1
  datasetId: string
  datasetVersion: string
  upstreamRepository: string
  upstreamRevision: string
  tasks: TerminalBenchTaskMetadata[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringProperty(value: unknown, key: string): string {
  if (!isRecord(value)) throw new Error('Invalid dataset descriptor.')
  const property = value[key]
  if (typeof property !== 'string' || !property) {
    throw new Error(`Dataset descriptor ${key} is invalid.`)
  }
  return property
}

function parseTask(value: unknown): TerminalBenchTaskMetadata {
  const task = {
    name: stringProperty(value, 'name'),
    image: stringProperty(value, 'image'),
    configSha256: stringProperty(value, 'configSha256'),
  }
  if (!/^[a-f0-9]{64}$/.test(task.configSha256)) {
    throw new Error(`Dataset task ${task.name} has an invalid config checksum.`)
  }
  if (!task.image.includes(':')) {
    throw new Error(`Dataset task ${task.name} has an invalid image reference.`)
  }
  return task
}

function parseDescriptor(value: unknown): TerminalBenchDatasetDescriptor {
  if (!isRecord(value) || value['schemaVersion'] !== 1) {
    throw new Error('Unsupported Terminal-Bench dataset descriptor.')
  }
  const rawTasks = value['tasks']
  if (!Array.isArray(rawTasks)) throw new Error('Dataset descriptor tasks are invalid.')
  const tasks = rawTasks.map(parseTask)
  if (tasks.length !== 89 || new Set(tasks.map((task) => task.name)).size !== tasks.length) {
    throw new Error('Terminal-Bench 2.1 descriptor must contain 89 unique tasks.')
  }
  return {
    schemaVersion: 1,
    datasetId: stringProperty(value, 'datasetId'),
    datasetVersion: stringProperty(value, 'datasetVersion'),
    upstreamRepository: stringProperty(value, 'upstreamRepository'),
    upstreamRevision: stringProperty(value, 'upstreamRevision'),
    tasks,
  }
}

export const TERMINAL_BENCH_DATASET_DESCRIPTOR = parseDescriptor(rawDescriptor)

export const TERMINAL_BENCH_TASK_NAMESPACE = 'terminal-bench'

export const TERMINAL_BENCH_TASK_NAMES = TERMINAL_BENCH_DATASET_DESCRIPTOR.tasks.map(
  (task) => task.name,
)

const TASKS_BY_NAME = new Map(
  TERMINAL_BENCH_DATASET_DESCRIPTOR.tasks.map((task) => [task.name, task]),
)

export function terminalBenchCanonicalTaskName(taskName: string): string {
  const trimmed = taskName.trim()
  const prefix = `${TERMINAL_BENCH_TASK_NAMESPACE}/`
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

export function terminalBenchQualifiedTaskName(taskName: string): string {
  return `${TERMINAL_BENCH_TASK_NAMESPACE}/${terminalBenchCanonicalTaskName(taskName)}`
}

export function terminalBenchTaskMetadata(taskName: string): TerminalBenchTaskMetadata {
  const task = TASKS_BY_NAME.get(terminalBenchCanonicalTaskName(taskName))
  if (!task) throw new Error(`Unknown Terminal-Bench 2.1 task '${taskName}'.`)
  return task
}

export function terminalBenchTaskImage(taskName: string): string {
  return terminalBenchTaskMetadata(taskName).image
}
