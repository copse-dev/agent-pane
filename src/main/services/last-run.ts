import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * How the previous run of this profile ended, so the next launch knows which
 * cut-off turns to continue (`interrupted-turn-resume.ts`).
 *
 * Each launch records when it started. An orderly quit then adds how it ended:
 * `update` when the updater relaunches the app to install, `quit` for every other
 * quit (the menu, a confirmed close, SIGINT/SIGTERM/SIGHUP). A crash or a kill
 * leaves the record without an ending.
 *
 * A quit the user chose stops the run, which is what the close dialog tells
 * them, so its turns are not continued. A crash or an update relaunch was not
 * the user's choice, so they are. Only turns that ran in that previous run
 * count: the start time bounds them, and a first launch with no record
 * continues nothing.
 */

export type RunEnding = 'quit' | 'update'

export interface LastRunRecord {
  /** Epoch ms when that run started. */
  startedAt: number
  /** How it ended; absent when it crashed or was killed. */
  ended?: RunEnding
}

const lastRunSchema = z.object({
  startedAt: z.number().int().nonnegative(),
  ended: z.enum(['quit', 'update']).optional(),
})

export function lastRunPath(userDataPath: string): string {
  return join(userDataPath, 'last-run.json')
}

/** The recorded run, or null when there is none or it cannot be read. */
export async function readLastRun(path: string): Promise<LastRunRecord | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = lastRunSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return null
    const { startedAt, ended } = parsed.data
    return ended === undefined ? { startedAt } : { startedAt, ended }
  } catch {
    return null
  }
}

/** Replace the record atomically, so a crash mid-write leaves the old one. */
export async function writeLastRun(path: string, record: LastRunRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Whether turns the previous run left `running` should continue now: it must
 * have left a record, and it must not have ended in a quit the user chose.
 */
export function previousRunAllowsResume(previous: LastRunRecord | null): boolean {
  return previous !== null && previous.ended !== 'quit'
}

/**
 * This process's run: reads the previous record once, then records this start.
 * `end` adds how this run ends; the updater calls `noteUpdateRelaunch` first so
 * its quit is recorded as `update`.
 */
export class RunRecorder {
  private readonly path: string
  private readonly startedAt: number
  private updating = false
  private ended = false
  readonly previous: Promise<LastRunRecord | null>

  constructor(path: string, startedAt: number) {
    this.path = path
    this.startedAt = startedAt
    this.previous = readLastRun(path).then(async (previous) => {
      await writeLastRun(path, { startedAt }).catch((error: unknown) => {
        console.error('[last-run] could not record this launch:', error)
      })
      return previous
    })
  }

  noteUpdateRelaunch(): void {
    this.updating = true
  }

  /** Record how this run ends. Only the first call counts. */
  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    // Wait for the start record so it cannot land after the ending.
    await this.previous
    await writeLastRun(this.path, {
      startedAt: this.startedAt,
      ended: this.updating ? 'update' : 'quit',
    }).catch((error: unknown) => {
      console.error('[last-run] could not record how this run ended:', error)
    })
  }
}

let recorder: RunRecorder | null = null

/** Start recording this run. Call once, early in boot. */
export function startRunRecorder(userDataPath: string, startedAt: number): RunRecorder {
  recorder ??= new RunRecorder(lastRunPath(userDataPath), startedAt)
  return recorder
}

/** The updater is about to relaunch the app to install an update. */
export function noteUpdateRelaunch(): void {
  recorder?.noteUpdateRelaunch()
}

/** Record that this run is ending in an orderly quit. */
export function recordRunEnd(): Promise<void> {
  return recorder?.end() ?? Promise.resolve()
}

/** How the previous run ended, once the recorder has read it. */
export function previousRun(): Promise<LastRunRecord | null> {
  return recorder?.previous ?? Promise.resolve(null)
}
