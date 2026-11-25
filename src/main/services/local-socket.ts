import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'

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
    : join(tmpdir(), `copse-${kind}-${hash}.sock`)
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
  try {
    const parsed = schema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
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
): Promise<LocalLineServer<Out>> {
  const clients = new Set<Socket>()
  const write = (socket: Socket, message: Out): void => {
    socket.write(`${JSON.stringify(message)}\n`)
  }
  const server: Server = createServer((socket) => {
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
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
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
