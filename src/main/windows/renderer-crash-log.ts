/**
 * A durable record of renderer deaths (#4445).
 *
 * The crash line in {@link attachRendererCrashRecovery} goes to stderr, which a
 * user only sees when Copse runs from a terminal. Each death is also appended
 * here, under the profile's `user-data/`, so `/checkup` can report it and the
 * file can be attached to a bug report.
 *
 * The file is JSON Lines and keeps only the newest {@link CRASH_LOG_MAX_ENTRIES}
 * records. Writes are best-effort: a diagnostic must never break recovery.
 * They are asynchronous (main-process reads are async-only, see
 * `docs/main-process-sync-reads.md`) and run one at a time, so trimming never
 * races a second append.
 */

import { promises as fsPromises } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { copseUserDataDir } from '../services/storage/copse-paths.ts'

export const CRASH_LOG_FILE = 'renderer-crashes.jsonl'
export const CRASH_LOG_MAX_ENTRIES = 100

const recordSchema = z.object({
  at: z.number(),
  window: z.string(),
  reason: z.string(),
  exitCode: z.number(),
  /** What the window was doing, such as the last large IPC call; null when nothing was known. */
  context: z.string().nullable(),
  /** `reloaded`, or `stopped` when the crash loop guard left the window down. */
  action: z.enum(['reloaded', 'stopped', 'none']),
})

export type RendererCrashRecord = z.infer<typeof recordSchema>

export function rendererCrashLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(copseUserDataDir(env), CRASH_LOG_FILE)
}

function parseLines(raw: string): RendererCrashRecord[] {
  return raw.split('\n').flatMap((line) => {
    if (line.trim() === '') return []
    const record = safeJsonParse(line, decodeWithSchema(recordSchema))
    return record ? [record] : []
  })
}

let writes: Promise<void> = Promise.resolve()

/** Append one record, trimming the file to the newest entries. Never rejects. */
export function appendRendererCrash(
  record: RendererCrashRecord,
  path: string = rendererCrashLogPath(),
): Promise<void> {
  writes = writes.then(async () => {
    try {
      await fsPromises.mkdir(dirname(path), { recursive: true })
      await fsPromises.appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      const records = parseLines(await fsPromises.readFile(path, 'utf8'))
      if (records.length > CRASH_LOG_MAX_ENTRIES) {
        const kept = records.slice(-CRASH_LOG_MAX_ENTRIES)
        await fsPromises.writeFile(
          path,
          kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
          {
            mode: 0o600,
          },
        )
      }
    } catch (error) {
      console.warn('[renderer] could not record the crash:', error)
    }
  })
  return writes
}

/** Records at or after `since`, oldest first. A missing or unreadable file reads as none. */
export async function readRendererCrashes(
  since: number,
  path: string = rendererCrashLogPath(),
): Promise<RendererCrashRecord[]> {
  let raw: string
  try {
    raw = await fsPromises.readFile(path, 'utf8')
  } catch {
    return []
  }
  return parseLines(raw).filter((record) => record.at >= since)
}
