import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { StreamChunk, TranscriptSnapshot, TranscriptStamp } from '@shared/types'

/**
 * The local line a turn worker serves while it runs a turn, so the app can
 * attach to it (`docs/plans/local-turn-worker.md` W4).
 *
 * One Unix socket (a named pipe on Windows) per worker, only reachable by this
 * user. Newline-delimited JSON. The app asks to `attach` and gets the turn's
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

/** Unix socket paths are short (104 bytes on macOS); keep well inside that. */
const MAX_SOCKET_PATH = 100

export function turnWorkerSocketPath(
  userDataPath: string,
  threadId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const id = createHash('sha256').update(`${userDataPath}\0${threadId}`).digest('hex').slice(0, 16)
  if (platform === 'win32') return `\\\\.\\pipe\\copse-turn-${id}`
  const inProfile = join(userDataPath, 'run', `turn-${id}.sock`)
  return inProfile.length <= MAX_SOCKET_PATH ? inProfile : join(tmpdir(), `copse-turn-${id}.sock`)
}

function lines(socket: Socket, onLine: (line: string) => void): void {
  let buffered = ''
  socket.setEncoding('utf8')
  socket.on('data', (data: string) => {
    buffered += data
    for (;;) {
      const end = buffered.indexOf('\n')
      if (end < 0) return
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      if (line.length > 0) onLine(line)
    }
  })
}

function decode<T>(schema: z.ZodType<T>, line: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
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
  const clients = new Set<Socket>()
  // Every connection, attached or not: `server.close` waits for all of them.
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    lines(socket, (line) => {
      const message = decode(appToWorkerSchema, line)
      if (message?.t === 'attach') {
        // Join before the reply, so the snapshot and the chunks after it arrive in order.
        clients.add(socket)
        handlers.onAttach()
      } else if (message?.t === 'stop') {
        handlers.onStop()
      }
    })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })
  if (process.platform !== 'win32') {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    // A socket left by a worker that died holds the path.
    rmSync(path, { force: true })
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    broadcast: (message): void => {
      const line = `${JSON.stringify(message)}\n`
      for (const socket of clients) socket.write(line)
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        for (const socket of clients) socket.end()
        // One that never attached gets nothing more; it must not hold the worker open.
        for (const socket of sockets) if (!clients.has(socket)) socket.destroy()
        server.close(() => {
          resolve()
        })
      }),
  }
}

export interface TurnWorkerConnection {
  send: (message: AppToWorker) => void
  close: () => void
}

/**
 * Connect to a worker. Resolves `null` when nothing is listening; `onClose`
 * runs once when a live connection ends.
 */
export function connectTurnWorker(
  path: string,
  onMessage: (message: WorkerToApp) => void,
  onClose: () => void,
): Promise<TurnWorkerConnection | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    let open = false
    socket.once('connect', () => {
      open = true
      lines(socket, (line) => {
        const message = decode(workerToAppSchema, line)
        if (message) onMessage(message)
      })
      resolve({
        send: (message) => {
          socket.write(`${JSON.stringify(message)}\n`)
        },
        close: () => {
          socket.end()
        },
      })
    })
    socket.on('error', () => {
      if (!open) resolve(null)
    })
    socket.once('close', () => {
      if (open) onClose()
    })
  })
}
