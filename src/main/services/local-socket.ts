import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

/**
 * A local line between two Copse processes of one profile: the app and a
 * process it started that outlives it, such as a turn worker or a container
 * run host (`docs/plans/local-turn-worker.md`).
 *
 * One Unix socket (a named pipe on Windows) per process, only reachable by this
 * user: the socket sits in a directory this user owns with mode 0700, checked
 * and tightened when it is served rather than left to the umask or to whatever
 * mode an existing directory had. Newline-delimited JSON, each line checked against a schema; a line that
 * does not parse is dropped.
 */

/** Unix socket paths are short (104 bytes on macOS); keep well inside that. */
const MAX_SOCKET_PATH = 100

/**
 * The socket for `kind` and `id` in this profile. When the profile path is too
 * long, the socket goes in a per-user directory under the temp directory
 * rather than straight in it: on Linux that is the shared `/tmp`.
 */
export function localSocketPath(
  userDataPath: string,
  kind: string,
  id: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const hash = createHash('sha256').update(`${userDataPath}\0${id}`).digest('hex').slice(0, 16)
  if (platform === 'win32') return `\\\\.\\pipe\\copse-${kind}-${hash}`
  const name = `${kind}-${hash}.sock`
  const inProfile = join(userDataPath, 'run', name)
  if (inProfile.length <= MAX_SOCKET_PATH) return inProfile
  const owner = `copse-${String(process.getuid?.() ?? 'user')}`
  // A long TMPDIR can push even the temp fallback past the limit, so end on
  // `/tmp`, which is short everywhere; the directory check in
  // `serveLocalLine` keeps it private either way.
  const inTemp = join(tmpdir(), owner, name)
  return inTemp.length <= MAX_SOCKET_PATH ? inTemp : join('/tmp', owner, name)
}

/**
 * Make `dir` a directory only this user can enter. `mkdirSync`'s mode applies
 * only to a directory it creates (and the umask can narrow it), so an existing
 * one is checked: a symlink or another user's directory is refused, and one of
 * ours with group or other access is tightened.
 */
function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to serve a local socket in ${dir}: it is not a directory.`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Refusing to serve a local socket in ${dir}: another user owns it.`)
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

/**
 * Whether `path` is a socket this user owns, in a directory only this user can
 * enter: what {@link serveLocalLine} leaves behind. A client checks before it
 * connects, so another user who got to a predictable fallback directory first
 * cannot stand in for the worker and feed the app forged messages.
 */
function isPrivateEndpoint(path: string): boolean {
  const uid = process.getuid?.()
  if (uid === undefined) return true
  try {
    const dir = lstatSync(dirname(path))
    const socket = lstatSync(path)
    return (
      dir.isDirectory() &&
      dir.uid === uid &&
      (dir.mode & 0o077) === 0 &&
      socket.isSocket() &&
      socket.uid === uid
    )
  } catch {
    return false
  }
}

/**
 * The longest line a peer may send. A peer that sends more without a newline
 * is not speaking the protocol, and holding it all would only grow memory, so
 * its connection is closed.
 */
export const MAX_LINE_CHARS = 128 * 1024 * 1024

function readLines(socket: Socket, onLine: (line: string) => void): void {
  // The pieces of the line so far: each chunk is scanned once, so a long line
  // costs its length, not its length times its chunks.
  let parts: string[] = []
  let length = 0
  socket.setEncoding('utf8')
  socket.on('data', (data: string) => {
    let start = 0
    for (;;) {
      const end = data.indexOf('\n', start)
      const piece = data.slice(start, end < 0 ? undefined : end)
      length += piece.length
      if (length > MAX_LINE_CHARS) {
        parts = []
        length = 0
        socket.destroy()
        return
      }
      if (end < 0) {
        if (piece.length > 0) parts.push(piece)
        return
      }
      const line = parts.length === 0 ? piece : parts.join('') + piece
      parts = []
      length = 0
      start = end + 1
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
  onLeave?: (client: LocalLineClient<Out>) => void,
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
      if (clients.delete(socket)) onLeave?.(client)
    }
    socket.on('close', leave)
    socket.on('error', leave)
  })
  if (process.platform !== 'win32') {
    ensurePrivateDirectory(dirname(path))
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
  // The directory already keeps others out; this covers a socket made under a
  // permissive umask should it ever be moved or its directory loosened.
  if (process.platform !== 'win32') chmodSync(path, 0o600)
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
 * Connect to a serving process. Resolves `null` when nothing is listening, or
 * when the endpoint is not this user's own private socket;
 * `onClose` runs once when a live connection ends.
 */
export function connectLocalLine<In, Out>(
  path: string,
  inbound: z.ZodType<In>,
  onMessage: (message: In) => void,
  onClose: () => void,
): Promise<LocalLineConnection<Out> | null> {
  if (process.platform !== 'win32' && !isPrivateEndpoint(path)) return Promise.resolve(null)
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
