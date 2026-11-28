import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * The turn host's durable note that it took a dispatched turn
 * (`docs/plans/local-turn-worker.md`, "Every turn in a turn host", decision 2).
 *
 * Written into the thread directory while the host holds the thread's writer
 * lease, before the turn starts, and marked `ended` after the turn's last
 * write. An app that lost the host's answer reads it to tell a turn the host
 * took (never run again in the app) from one it provably never ran.
 */

export const HOST_DISPATCH_FILE = 'host-dispatch.json'

export interface HostDispatchRecord {
  operationId: string
  state: 'claimed' | 'ended'
  at: number
}

const recordSchema = z.object({
  operationId: z.string().min(1),
  state: z.enum(['claimed', 'ended']),
  at: z.number(),
})

export async function writeHostDispatchRecord(
  threadDir: string,
  record: HostDispatchRecord,
): Promise<void> {
  const path = join(threadDir, HOST_DISPATCH_FILE)
  const staged = `${path}.${String(process.pid)}.tmp`
  await writeFile(staged, `${JSON.stringify(record)}\n`, 'utf8')
  await rename(staged, path)
}

/**
 * The thread's record, or null when there is none. A record that is there but
 * does not parse throws: it cannot prove the host never ran the turn.
 */
export async function readHostDispatchRecord(
  threadDir: string,
): Promise<HostDispatchRecord | null> {
  let text: string
  try {
    text = await readFile(join(threadDir, HOST_DISPATCH_FILE), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  return parseHostDispatchRecord(text)
}

/** A record's text, as a host on another machine has it; throws when it does not parse. */
export function parseHostDispatchRecord(text: string): HostDispatchRecord {
  return recordSchema.parse(JSON.parse(text))
}
