import { z } from 'zod'
import {
  connectLocalLine,
  localSocketPath,
  serveLocalLine,
  type LocalLineConnection,
} from '../local-socket.ts'
import type { StreamChunk, TranscriptSnapshot, TranscriptStamp } from '@shared/types'

/**
 * The local line a turn worker serves while it runs a turn, so the app can
 * attach to it (`docs/plans/local-turn-worker.md` W4).
 *
 * One local line per worker (`local-socket.ts`). The app asks to `attach` and gets the turn's
 * runtime snapshot, then every chunk as the worker's transcript writer stamps
 * it, the same order an in-process turn reaches the window. `stop` aborts the
 * turn as the Stop button does for a turn the app runs itself.
 *
 * The thread's files stay the record: a dropped line costs the live stream,
 * not the turn, and the app falls back to repainting from disk.
 */

export type AppToWorker = { t: 'attach' } | { t: 'stop' }

export type WorkerToApp =
  | { t: 'chunk'; threadId: string; chunk: StreamChunk; stamp?: TranscriptStamp | undefined }
  | { t: 'snapshot'; snapshot: TranscriptSnapshot }

const appToWorkerSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('attach') }),
  z.object({ t: z.literal('stop') }),
])

// Chunks and snapshots come from this user's own worker, written by the same
// code that writes them in-process; the envelope is checked, the payload is not.
const workerToAppSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('chunk'),
    threadId: z.string().min(1),
    chunk: z.custom<StreamChunk>((value) => typeof value === 'object' && value !== null),
    stamp: z
      .custom<TranscriptStamp>((value) => typeof value === 'object' && value !== null)
      .optional(),
  }),
  z.object({
    t: z.literal('snapshot'),
    snapshot: z.custom<TranscriptSnapshot>((value) => typeof value === 'object' && value !== null),
  }),
])

export function turnWorkerSocketPath(
  userDataPath: string,
  threadId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return localSocketPath(userDataPath, 'turn', threadId, platform)
}

export interface TurnWorkerServer {
  /** Send a message to every attached app. */
  broadcast: (message: WorkerToApp) => void
  close: () => Promise<void>
}

/** Serve `path` until closed. Each `attach` gets a reply through `onAttach`. */
export async function serveTurnWorker(
  path: string,
  handlers: { onAttach: () => void; onStop: () => void },
): Promise<TurnWorkerServer> {
  const server = await serveLocalLine<AppToWorker, WorkerToApp>(
    path,
    appToWorkerSchema,
    (message, client) => {
      if (message.t === 'attach') {
        // Join before the reply, so the snapshot and the chunks after it arrive in order.
        client.join()
        handlers.onAttach()
      } else {
        handlers.onStop()
      }
    },
  )
  return { broadcast: server.broadcast, close: server.close }
}

export type TurnWorkerConnection = LocalLineConnection<AppToWorker>

/**
 * Connect to a worker. Resolves `null` when nothing is listening; `onClose`
 * runs once when a live connection ends.
 */
export function connectTurnWorker(
  path: string,
  onMessage: (message: WorkerToApp) => void,
  onClose: () => void,
): Promise<TurnWorkerConnection | null> {
  return connectLocalLine<WorkerToApp, AppToWorker>(path, workerToAppSchema, onMessage, onClose)
}
