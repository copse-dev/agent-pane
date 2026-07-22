import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { terminalBenchTaskImage } from './terminal-bench-tasks.mts'

export async function recordTerminalBenchTaskImage(
  taskName: string,
  resultPath: string,
): Promise<void> {
  const reference = terminalBenchTaskImage(taskName)
  const inspect = spawnSync('docker', ['image', 'inspect', reference], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  if (inspect.error || inspect.status !== 0) {
    console.warn(`bench:terminal unable to inspect completed task image ${reference}`)
    return
  }
  let records: unknown
  try {
    records = JSON.parse(inspect.stdout)
  } catch (error) {
    console.warn(`bench:terminal unable to parse image inspection: ${String(error)}`)
    return
  }
  const image = Array.isArray(records) ? (records as unknown[])[0] : undefined
  const field = (key: string): unknown => {
    if (typeof image !== 'object' || image === null) return undefined
    return (image as Record<string, unknown>)[key]
  }
  await writeFile(
    join(dirname(resultPath), 'task-image.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        reference,
        imageId: field('Id') ?? null,
        repoDigests: field('RepoDigests') ?? [],
        created: field('Created') ?? null,
        architecture: field('Architecture') ?? null,
        os: field('Os') ?? null,
      },
      null,
      2,
    )}\n`,
  )
}
