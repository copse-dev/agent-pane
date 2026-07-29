import { spawnSync } from 'node:child_process'
import { firstNonEmptyString, nonEmptyStringOr } from '../src/shared/unknown-value.mts'
import { appendFileSync, mkdirSync, statfsSync } from 'node:fs'
import { freemem, loadavg, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'

const outputPath = resolve(process.argv[2] ?? 'bench-results/terminal-bench-host-metrics.jsonl')
const rawInterval = nonEmptyStringOr(
  process.env['COPSE_TERMINAL_HOST_METRICS_INTERVAL_SECONDS']?.trim(),
  '30',
)
if (!/^[1-9][0-9]*$/.test(rawInterval)) {
  throw new Error('COPSE_TERMINAL_HOST_METRICS_INTERVAL_SECONDS must be a positive integer')
}
const intervalMilliseconds = Number(rawInterval) * 1_000

function dockerStats(): unknown[] {
  const result = spawnSync('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.error || result.status !== 0) {
    return [
      {
        error: nonEmptyStringOr(
          firstNonEmptyString(result.error?.message, result.stderr.trim()),
          `docker exited ${String(result.status)}`,
        ),
      },
    ]
  }
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return { raw: line }
      }
    })
}

function sample(): void {
  try {
    const disk = statfsSync(dirname(outputPath))
    appendFileSync(
      outputPath,
      `${JSON.stringify({
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        shardIndex: process.env['COPSE_TERMINAL_SHARD_INDEX'] ?? null,
        host: {
          loadAverage: loadavg(),
          memoryFreeBytes: freemem(),
          memoryTotalBytes: totalmem(),
          diskAvailableBytes: disk.bavail * disk.bsize,
          diskTotalBytes: disk.blocks * disk.bsize,
        },
        containers: dockerStats(),
      })}\n`,
    )
  } catch (error) {
    console.error(
      `terminal-bench metrics: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

mkdirSync(dirname(outputPath), { recursive: true })
sample()
const timer = setInterval(sample, intervalMilliseconds)
const stop = (): void => {
  clearInterval(timer)
  sample()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
