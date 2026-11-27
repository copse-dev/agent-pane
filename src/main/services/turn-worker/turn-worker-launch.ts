import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Hand the turns a quit cut off to turn workers (`docs/plans/local-turn-worker.md`
 * W2), so they continue now instead of at the next launch.
 *
 * Each worker is the app's own binary run as Node on `turn-worker.js`, detached
 * into its own process group with its output in a log file, so nothing ties it
 * to the app that is exiting. A worker that finds the thread not resumable, or
 * still held, exits by itself; the next launch then continues the turn as before.
 */

/** Whether a quit hands its turns to workers. */
export const CONTINUE_TURNS_AFTER_QUIT_SETTING = 'continueTurnsAfterQuit'
/**
 * Off until Settings offers the switch and Stop reaches a worker's turn; until
 * then a quit stops its turns, as it did before the worker.
 */
export const CONTINUE_TURNS_AFTER_QUIT_DEFAULT = false

/** Whether a quit the user confirmed should hand its turns off. */
export function continuesTurnsAfterQuit(
  read: (key: string, fallback: boolean) => unknown,
): boolean {
  return read(CONTINUE_TURNS_AFTER_QUIT_SETTING, CONTINUE_TURNS_AFTER_QUIT_DEFAULT) === true
}

/**
 * Whether a quit now would keep every one of `turns` going in a worker: the
 * quit hands off (`handsOff`), and the worker runs each turn rather than
 * leaving it for the next launch (`cannotRun`, `turn-worker.ts`).
 */
export async function everyTurnHandsOff(
  turns: readonly HandOffTarget[],
  handsOff: boolean,
  cannotRun: (projectId: string, threadId: string) => Promise<string | null>,
): Promise<boolean> {
  if (!handsOff) return false
  const reasons = await Promise.all(turns.map((turn) => cannotRun(turn.projectId, turn.threadId)))
  return reasons.every((reason) => reason === null)
}

export interface HandOffTarget {
  projectId: string
  threadId: string
}

type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void; pid?: number | undefined }

export interface TurnWorkerLaunchDependencies {
  /** The app's executable; run as Node through `ELECTRON_RUN_AS_NODE`. */
  execPath: string
  /** `dist/main/turn-worker.js`, next to the main bundle. */
  workerPath: string
  userDataPath: string
  appVersion: string
  packaged: boolean
  env: NodeJS.ProcessEnv
  spawn?: Spawn
  /** A file descriptor the worker writes its log to. */
  openLog?: (threadId: string) => number
  log?: (line: string) => void
}

/** `turn-worker.js` beside the main bundle that imports this module. */
export function turnWorkerPath(): string {
  return join(__dirname, 'turn-worker.js')
}

export function turnWorkerLogPath(userDataPath: string, threadId: string): string {
  return join(userDataPath, 'logs', `turn-worker-${threadId}.log`)
}

function openLogFile(userDataPath: string, threadId: string): number {
  const path = turnWorkerLogPath(userDataPath, threadId)
  mkdirSync(join(userDataPath, 'logs'), { recursive: true })
  return openSync(path, 'a', 0o600)
}

/** Start one worker per target. Returns the targets a worker was started for. */
export function handOffTurns(
  targets: readonly HandOffTarget[],
  deps: TurnWorkerLaunchDependencies,
): HandOffTarget[] {
  const run = deps.spawn ?? spawn
  const started: HandOffTarget[] = []
  for (const target of targets) {
    try {
      const log = deps.openLog?.(target.threadId) ?? openLogFile(deps.userDataPath, target.threadId)
      const child = run(
        deps.execPath,
        [
          deps.workerPath,
          '--user-data',
          deps.userDataPath,
          '--project',
          target.projectId,
          '--thread',
          target.threadId,
          '--app-version',
          deps.appVersion,
          ...(deps.packaged ? ['--packaged'] : []),
        ],
        {
          env: { ...deps.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', log, log],
          // Its own process group: the app's exit, or a signal to its group,
          // must not take the worker with it.
          detached: true,
        },
      )
      child.unref()
      started.push(target)
      deps.log?.(`[turn-worker] handed ${target.threadId} to pid ${String(child.pid ?? 'unknown')}`)
    } catch (error) {
      deps.log?.(`[turn-worker] could not hand off ${target.threadId}: ${String(error)}`)
    }
  }
  return started
}
