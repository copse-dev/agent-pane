import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

/**
 * A local line between two Copse processes of one profile: the app and a
 * process it started that outlives it, such as a turn worker or a container
 * run host (`docs/plans/local-turn-worker.md`).
 *
 * One Unix socket (a named pipe on Windows) per process, only reachable by this
 * user. Newline-delimited JSON, each line checked against a schema; a line that
 * does not parse is dropped.
 */

/** Unix socket paths are short (104 bytes on macOS); keep well inside that. */
const MAX_SOCKET_PATH = 100

/** The socket for `kind` and `id` in this profile. */
export function localSocketPath(
  userDataPath: string,
  kind: string,
  id: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const hash = createHash('sha256').update(`${userDataPath}\0${id}`).digest('hex').slice(0, 16)
  if (platform === 'win32') return `\\\\.\\pipe\\copse-${kind}-${hash}`
  const inProfile = join(userDataPath, 'run', `${kind}-${hash}.sock`)
  return inProfile.length <= MAX_SOCKET_PATH
    ? inProfile
    : join(privateTmpRunDir(), `${kind}-${hash}.sock`)
}

/**
 * Where a socket goes when the profile's own path is too long. The temp
 * directory can be shared between users (`/tmp` on Linux), where a bare,
 * guessable socket name could be taken first by another user. So it is a
 * directory only this user can enter, and one that is not refuses to be used.
 */
function privateTmpRunDir(): string {
  const uid = process.getuid?.() ?? 0
  const dir = join(tmpdir(), `copse-run-${String(uid)}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a directory only this user can reach`)
  }
  return dir
}

function readLines(socket: Socket, onLine: (line: string) => void): void {
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
  return safeJsonParse(line, decodeWithSchema(schema))
}

/** One connected peer, as the serving process sees it. */
export interface LocalLineClient<Out> {
  /** Add the peer to those {@link LocalLineServer.broadcast} reaches. */
  join: () => void
  send: (message: Out) => void
}

export interface LocalLineServer<Out> {
  /** Send a message to every joined peer. */
  broadcast: (message: Out) => void
  /** Joined peers still connected. */
  joined: () => number
  close: () => Promise<void>
}

/** Serve `path` until closed. */
export async function serveLocalLine<In, Out>(
  path: string,
  inbound: z.ZodType<In>,
  onMessage: (message: In, client: LocalLineClient<Out>) => void,
  /** A joined peer's line closed. */
  onLeave?: () => void,
): Promise<LocalLineServer<Out>> {
  const clients = new Set<Socket>()
  // Every connection, joined or not: `server.close` waits for all of them.
  const sockets = new Set<Socket>()
  const write = (socket: Socket, message: Out): void => {
    socket.write(`${JSON.stringify(message)}\n`)
  }
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    const client: LocalLineClient<Out> = {
      join: () => clients.add(socket),
      send: (message) => {
        write(socket, message)
      },
    }
    readLines(socket, (line) => {
      const message = decode(inbound, line)
      if (message !== null) onMessage(message, client)
    })
    const leave = (): void => {
      sockets.delete(socket)
      if (clients.delete(socket)) onLeave?.()
    }
    socket.on('close', leave)
    socket.on('error', leave)
  })
  if (process.platform !== 'win32') {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    // A socket left by a process that died holds the path.
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
      for (const socket of clients) write(socket, message)
    },
    joined: (): number => clients.size,
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        for (const socket of clients) socket.end()
        // One that never joined gets nothing more; it must not hold the server open.
        for (const socket of sockets) if (!clients.has(socket)) socket.destroy()
        server.close(() => {
          resolve()
        })
      }),
  }
}

export interface LocalLineConnection<Out> {
  send: (message: Out) => void
  close: () => void
}

/**
 * Connect to a serving process. Resolves `null` when nothing is listening;
 * `onClose` runs once when a live connection ends.
 */
export function connectLocalLine<In, Out>(
  path: string,
  inbound: z.ZodType<In>,
  onMessage: (message: In) => void,
  onClose: () => void,
): Promise<LocalLineConnection<Out> | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    let open = false
    socket.once('connect', () => {
      open = true
      readLines(socket, (line) => {
        const message = decode(inbound, line)
        if (message !== null) onMessage(message)
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
