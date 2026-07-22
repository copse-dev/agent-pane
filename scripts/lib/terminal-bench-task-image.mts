import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  TERMINAL_BENCH_DATASET_DESCRIPTOR,
  terminalBenchTaskMetadata,
} from './terminal-bench-tasks.mts'

export interface TerminalBenchTaskImageMetadata {
  schemaVersion: 2
  datasetId: string
  datasetVersion: string
  datasetRevision: string
  taskConfigSha256: string
  reference: string
  imageId: string
  repoDigests: string[]
  created: string | null
  architecture: string
  os: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function stringField(value: unknown, name: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[name]
  return typeof field === 'string' && field ? field : undefined
}

export function inspectTerminalBenchTaskImage(taskName: string): TerminalBenchTaskImageMetadata {
  const task = terminalBenchTaskMetadata(taskName)
  const reference = task.image
  const inspect = spawnSync('docker', ['image', 'inspect', reference], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  if (inspect.error || inspect.status !== 0) {
    throw new Error(`bench:terminal unable to inspect completed task image ${reference}`)
  }
  let records: unknown
  try {
    records = JSON.parse(inspect.stdout)
  } catch (error) {
    throw new Error(`bench:terminal unable to parse image inspection: ${String(error)}`, {
      cause: error,
    })
  }
  const image = isUnknownArray(records) ? records[0] : undefined
  const imageId = stringField(image, 'Id')
  const rawRepoDigests = isRecord(image) ? image['RepoDigests'] : undefined
  const repoDigests = isUnknownArray(rawRepoDigests)
    ? rawRepoDigests.filter(
        (digest): digest is string =>
          typeof digest === 'string' && /@sha256:[a-f0-9]{64}$/.test(digest),
      )
    : []
  const architecture = stringField(image, 'Architecture')
  const os = stringField(image, 'Os')
  if (!imageId || !/^sha256:[a-f0-9]{64}$/.test(imageId) || repoDigests.length === 0) {
    throw new Error(`bench:terminal image ${reference} is missing immutable digest metadata`)
  }
  if (!architecture || !os) {
    throw new Error(`bench:terminal image ${reference} is missing platform metadata`)
  }
  return {
    schemaVersion: 2,
    datasetId: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId,
    datasetVersion: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetVersion,
    datasetRevision: TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision,
    taskConfigSha256: task.configSha256,
    reference,
    imageId,
    repoDigests,
    created: stringField(image, 'Created') ?? null,
    architecture,
    os,
  }
}

export async function recordTerminalBenchTaskImage(
  taskName: string,
  resultPath: string,
): Promise<void> {
  const metadata = inspectTerminalBenchTaskImage(taskName)
  await writeFile(
    join(dirname(resultPath), 'task-image.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  )
}
