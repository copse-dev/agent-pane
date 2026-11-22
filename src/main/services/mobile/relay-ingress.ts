import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls'
import type { PublicIdentity } from '../remote-names/names-service.ts'

export interface RelayIngress {
  /** Complete one relayed browser connection's TLS and serve it. */
  accept(stream: Duplex, clientIp: string): void
  connections(): number
  close(): void
}

/** Relayed browser connections served at once; the tunnel and the relay cap streams too. */
const MAX_CONNECTIONS = 16

/**
 * Browser connections that reach this Mac through the Copse relay. Each one
 * arrives as the browser's TLS bytes from the ClientHello on; this Mac
 * completes the handshake with its own `*.<label>.u.copse.me` certificate, so
 * the relay only ever carried ciphertext. The HTTP server never listens on a
 * port: it only sees connections handed to it here, which is how the request
 * handler knows a request was relayed and which address the relay saw.
 */
export function createRelayIngress(options: {
  /** The label's certificate while it is valid; a connection arriving without one is closed. */
  identity: () => PublicIdentity | null
  handle: (req: IncomingMessage, res: ServerResponse, clientIp: string) => void
  maxConnections?: number
  handshakeTimeoutMs?: number
}): RelayIngress {
  const clients = new Map<Socket, string>()
  let contextCache: { identity: PublicIdentity; context: SecureContext } | null = null
  let closed = false
  const server = createServer((req, res) => {
    const clientIp = clients.get(req.socket)
    if (clientIp === undefined) {
      res.destroy()
      return
    }
    options.handle(req, res, clientIp)
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.timeout = 75_000

  const contextFor = (identity: PublicIdentity): SecureContext => {
    if (contextCache?.identity !== identity)
      contextCache = {
        identity,
        context: createSecureContext({
          key: identity.key,
          cert: identity.cert,
          minVersion: 'TLSv1.2',
        }),
      }
    return contextCache.context
  }

  return {
    accept(stream, clientIp): void {
      const identity = options.identity()
      if (closed || !identity || clients.size >= (options.maxConnections ?? MAX_CONNECTIONS)) {
        stream.destroy()
        return
      }
      let socket: TLSSocket
      try {
        socket = new TLSSocket(stream, {
          isServer: true,
          secureContext: contextFor(identity),
          ALPNProtocols: ['http/1.1'],
        })
      } catch {
        stream.destroy()
        return
      }
      clients.set(socket, clientIp)
      const handshake = setTimeout(() => {
        socket.destroy()
      }, options.handshakeTimeoutMs ?? 10_000)
      handshake.unref()
      socket.once('secure', () => {
        clearTimeout(handshake)
      })
      socket.on('error', () => {
        socket.destroy()
      })
      socket.on('close', () => {
        clearTimeout(handshake)
        clients.delete(socket)
        stream.destroy()
      })
      stream.on('close', () => {
        socket.destroy()
      })
      server.emit('connection', socket)
    },
    connections: () => clients.size,
    close(): void {
      closed = true
      for (const socket of clients.keys()) socket.destroy()
      clients.clear()
      server.closeAllConnections()
    },
  }
}
