import { randomBytes } from 'node:crypto'
import { request, type IncomingHttpHeaders } from 'node:http'
import http2 from 'node:http2'
import type { Duplex } from 'node:stream'
import { connect, createServer, type Server, type TLSSocket } from 'node:tls'
import { toBase64Url } from '@copse/remote-protocol/encoding.ts'
import { verifyText } from '@copse/remote-protocol/keys.ts'
import { TunnelAuth, tunnelSigningText } from '@copse/remote-protocol/tunnel.ts'
import { decodeWithSchema, safeJsonParse } from '../../packages/std/src/safe-json.ts'
import { createTestCa, testServerIdentity } from './test-certificates.ts'

/**
 * A stand-in for the Copse relay (`copse-dev/remote-service` `relay/src/relay.ts`)
 * reduced to the tunnel side: it terminates the Mac's TLS with its own
 * certificate, sends a challenge, verifies the device-key signature and the
 * timestamp the way the relay does, then becomes the HTTP/2 client. A test
 * plays the browser by opening a `CONNECT` stream and running TLS over it,
 * which is what the relay does after splicing a browser's socket.
 */

export interface FakeRelay {
  hostname: string
  port: number
  /** The relay's own root; the Mac must trust it to open the tunnel. */
  caPem: string
  /** Labels whose tunnel handshake verified, in order. */
  authenticated: string[]
  /** Why each refused handshake was refused. */
  refused: string[]
  tunnels(): number
  waitForTunnel(timeoutMs?: number): Promise<void>
  /** A `CONNECT` stream on the newest tunnel and the Mac's response status. */
  openStream(headers: { authority: string; clientIp?: string; method?: string }): Promise<{
    stream: http2.ClientHttp2Stream
    status: number | null
  }>
  /** One HTTPS request from a "browser" whose TLS runs end to end through the tunnel. */
  browserRequest(options: {
    serverName: string
    ca: string
    path?: string
    method?: string
    headers?: Record<string, string>
    body?: string
    clientIp?: string
  }): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>
  /** The HTTP/2 settings the Mac advertised on the newest tunnel, once received. */
  peerSettings(): http2.Settings | null
  /** Close every tunnel, as a relay restart or a network drop would. */
  dropTunnels(): void
  close(): Promise<void>
}

function readLine(socket: Duplex, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => {
      finish(new Error('timed out'))
    }, timeoutMs)
    const finish = (error: Error | null, line = ''): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      if (error) reject(error)
      else resolve(line)
    }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline === -1) return
      socket.pause()
      finish(null, buffered.subarray(0, newline).toString('utf8'))
    }
    const onClose = (): void => {
      finish(new Error('closed'))
    }
    socket.on('data', onData)
    socket.on('close', onClose)
  })
}

export async function startFakeRelay(options: {
  /** The device public key the names service holds for a label, or null for an unknown one. */
  deviceKey: (label: string) => Promise<CryptoKey | null>
  hostname?: string
  port?: number
}): Promise<FakeRelay> {
  const hostname = options.hostname ?? 'relay.copse.test'
  const ca = createTestCa('Copse test relay CA')
  const identity = testServerIdentity(ca, [hostname])
  const sessions: http2.ClientHttp2Session[] = []
  const authenticated: string[] = []
  const refused: string[] = []
  const waiters: (() => void)[] = []
  const sockets = new Set<TLSSocket>()

  const accept = async (socket: TLSSocket): Promise<void> => {
    const challenge = toBase64Url(randomBytes(32))
    socket.write(`${JSON.stringify({ type: 'challenge', challenge })}\n`)
    const auth = safeJsonParse(await readLine(socket, 5000), decodeWithSchema(TunnelAuth))
    const refuse = (reason: string): void => {
      refused.push(reason)
      socket.destroy()
    }
    if (!auth) {
      refuse('malformed auth line')
      return
    }
    if (Math.abs(Date.now() - auth.timestampMs) > 300_000) {
      refuse('stale timestamp')
      return
    }
    const key = await options.deviceKey(auth.label)
    if (!key) {
      refuse(`unknown label ${auth.label}`)
      return
    }
    if (
      !(await verifyText(
        key,
        tunnelSigningText(auth.label, challenge, auth.timestampMs),
        auth.signature,
      ))
    ) {
      refuse('signature does not verify')
      return
    }
    await new Promise<void>((resolve, reject) => {
      socket.write(`${JSON.stringify({ type: 'ready' })}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    const session = http2.connect(`http://${auth.label}.tunnel.invalid`, {
      createConnection: () => socket,
    })
    // As in the relay: Node clears `secureConnecting` only on client-side TLS
    // sockets, so announce the finished handshake before HTTP/2 waits for it.
    socket.emit('secureConnect')
    session.on('error', () => {
      session.destroy()
    })
    session.on('close', () => {
      const index = sessions.indexOf(session)
      if (index !== -1) sessions.splice(index, 1)
    })
    // A newer tunnel replaces the older one.
    for (const previous of sessions.splice(0)) previous.destroy()
    sessions.push(session)
    authenticated.push(auth.label)
    for (const wake of waiters.splice(0)) wake()
  }

  const server: Server = createServer(
    { key: identity.key, cert: identity.cert, ALPNProtocols: ['h2'] },
    (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {
        socket.destroy()
      })
      accept(socket).catch(() => {
        socket.destroy()
      })
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const openStream: FakeRelay['openStream'] = (headers) => {
    const session = sessions.at(-1)
    if (!session) return Promise.reject(new Error('no tunnel'))
    const stream = session.request({
      ':method': headers.method ?? 'CONNECT',
      ':authority': headers.authority,
      ...(headers.clientIp === undefined ? {} : { 'copse-client-ip': headers.clientIp }),
    })
    return new Promise((resolve) => {
      stream.once('response', (response) => {
        const status = response[':status']
        resolve({ stream, status: typeof status === 'number' ? status : null })
      })
      stream.once('close', () => {
        resolve({ stream, status: null })
      })
      stream.on('error', () => {
        stream.destroy()
      })
    })
  }

  return {
    hostname,
    port,
    caPem: ca.pem,
    authenticated,
    refused,
    tunnels: () => sessions.length,
    peerSettings: () => sessions.at(-1)?.remoteSettings ?? null,
    waitForTunnel: (timeoutMs = 10_000) =>
      sessions.length > 0
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('no tunnel connected'))
            }, timeoutMs)
            waiters.push(() => {
              clearTimeout(timer)
              resolve()
            })
          }),
    openStream,
    async browserRequest(input): ReturnType<FakeRelay['browserRequest']> {
      const { stream, status } = await openStream({
        authority: `${input.serverName}:443`,
        clientIp: input.clientIp ?? '203.0.113.7',
      })
      if (status !== 200) throw new Error(`the Mac answered CONNECT with ${String(status)}`)
      const socket = connect({ socket: stream, servername: input.serverName, ca: input.ca })
      return new Promise((resolve, reject) => {
        const req = request(
          {
            createConnection: () => socket,
            method: input.method ?? 'GET',
            path: input.path ?? '/',
            headers: { host: input.serverName, connection: 'close', ...input.headers },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              })
            })
            res.on('error', reject)
          },
        )
        req.on('error', reject)
        req.end(input.body)
      })
    },
    dropTunnels(): void {
      for (const session of sessions.splice(0)) session.destroy()
    },
    async close(): Promise<void> {
      for (const session of sessions.splice(0)) session.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
