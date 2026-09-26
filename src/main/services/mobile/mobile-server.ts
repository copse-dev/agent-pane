import { randomInt, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { isPrivateOrLinkLocalHost } from '@copse/llm/credential-url.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { mobileActivity, mobileThread } from './mobile-activity.ts'
import { mobileCertificate } from './mobile-certificate.ts'
import { MobileDevices } from './mobile-devices.ts'

/** The complete data surface available to a paired phone. */
export const MOBILE_READ_DISPATCH = Object.freeze({
  activity: mobileActivity,
  thread: mobileThread,
})

const PAIR_TIMEOUT_MS = 120_000
/** A stable origin preserves the phone's paired token across Copse restarts. */
export const MOBILE_PORT = 42773
const pairSchema = z.object({ label: z.string().trim().min(1).max(64) })
const idPattern = /^[\w-]{1,128}$/

export function mobileLanAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).flatMap((entry) =>
      entry.family === 'IPv4' && !entry.internal && isRfc1918(entry.address) ? [entry.address] : [],
    ),
  )
}

function isRfc1918(address: string): boolean {
  const parts = address.split('.').map(Number)
  return (
    parts.length === 4 &&
    (parts[0] === 10 ||
      (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  )
}

/** Reject DNS rebinding, cross-origin calls, and public peers before any route dispatch. */
export function mobileRequestAllowed(
  req: IncomingMessage,
  authority: string,
  origin: string,
): boolean {
  const peer = req.socket.remoteAddress
  if (!peer || !isPrivateOrLinkLocalHost(peer)) return false
  if (req.headers.host !== authority) return false
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false
  if (req.method !== 'GET' && req.headers.origin !== origin) return false
  return true
}

function headers(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, headers('application/json; charset=utf-8'))
  res.end(JSON.stringify(value))
}

async function readPairBody(req: IncomingMessage): Promise<{ label: string } | null> {
  const chunks: Buffer[] = []
  let length = 0
  try {
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) return null
      length += chunk.length
      if (length > 1024) return null
      chunks.push(chunk)
    }
  } catch {
    return null
  }
  return safeJsonParse(Buffer.concat(chunks).toString('utf8'), decodeWithSchema(pairSchema))
}

interface Pairing {
  peer: string
  createdAt: number
  token?: string
  denied?: boolean
}

export interface MobileServer {
  url: string
  rootPath: string
  devices: MobileDevices
  isRunning(): boolean
  close(): Promise<void>
}

export async function startMobileServer(options: {
  address: string
  devices: MobileDevices
  approvePair: (label: string, code: string) => Promise<boolean>
  assetsDir?: string
  onStop?: () => void
}): Promise<MobileServer> {
  if (!mobileLanAddresses().includes(options.address))
    throw new Error('Choose an active private IPv4 interface')
  const identity = mobileCertificate(options.address)
  const assets = options.assetsDir ?? join(__dirname, '..', 'mobile')
  const files = new Map([
    ['/', { path: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/app.css', { path: 'app.css', type: 'text/css; charset=utf-8' }],
    ['/app.js', { path: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ])
  // Read once, before binding, so a missing package asset cannot yield a
  // half-working listener. The map is fixed and contains no user path.
  const staticFiles = new Map(
    [...files].map(([route, file]) => [
      route,
      {
        body: readFileSync(join(assets, file.path)),
        type: file.type,
      },
    ]),
  )
  const pairings = new Map<string, Pairing>()
  const failedAuth = new Map<string, { attempts: number; blockedUntil: number }>()
  let stopped = false
  let authority = ''
  let origin = ''
  const server: Server = createServer(
    { key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' },
    (req, res) => {
      void (async (): Promise<void> => {
        if (!mobileRequestAllowed(req, authority, origin)) {
          send(res, 403, { error: 'Forbidden' })
          return
        }
        const path = new URL(req.url ?? '/', origin)
        if (req.method === 'GET') {
          const file = staticFiles.get(path.pathname)
          if (file) {
            res.writeHead(200, headers(file.type))
            res.end(file.body)
            return
          }
        }
        if (req.method === 'POST' && path.pathname === '/api/pair/request') {
          for (const [id, pairing] of pairings) {
            if (Date.now() - pairing.createdAt > PAIR_TIMEOUT_MS) pairings.delete(id)
          }
          if (pairings.size >= 1) {
            send(res, 429, { error: 'Pairing already in progress' })
            return
          }
          const body = await readPairBody(req)
          if (!body) {
            send(res, 400, { error: 'Invalid pairing request' })
            return
          }
          const id = randomUUID()
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
          const pairing: Pairing = { peer: req.socket.remoteAddress ?? '', createdAt: Date.now() }
          pairings.set(id, pairing)
          send(res, 200, { id, code })
          void options
            .approvePair(body.label, code)
            .then((approved) => {
              if (pairings.get(id) !== pairing) return
              if (approved) pairing.token = options.devices.issue(body.label).token
              else pairing.denied = true
            })
            .catch(() => {
              pairing.denied = true
            })
          return
        }
        if (req.method === 'GET' && path.pathname === '/api/pair/result') {
          const id = path.searchParams.get('id') ?? ''
          const pairing = pairings.get(id)
          if (
            !pairing ||
            pairing.peer !== req.socket.remoteAddress ||
            Date.now() - pairing.createdAt > PAIR_TIMEOUT_MS
          ) {
            send(res, 404, { error: 'Pairing expired' })
            return
          }
          if (pairing.token) {
            pairings.delete(id)
            send(res, 200, { state: 'approved', token: pairing.token })
          } else if (pairing.denied) {
            pairings.delete(id)
            send(res, 200, { state: 'denied' })
          } else send(res, 200, { state: 'waiting' })
          return
        }
        // The bearer check precedes every protected body read and store access.
        const peer = req.socket.remoteAddress ?? ''
        const prior = failedAuth.get(peer)
        if (prior && prior.blockedUntil > Date.now()) {
          send(res, 429, { error: 'Too many failed requests' })
          return
        }
        if (!options.devices.authenticate(req.headers.authorization)) {
          const attempts =
            prior?.blockedUntil && prior.blockedUntil < Date.now() ? 1 : (prior?.attempts ?? 0) + 1
          failedAuth.set(peer, {
            attempts,
            blockedUntil: attempts >= 30 ? Date.now() + 300_000 : 0,
          })
          send(res, 401, { error: 'Pair this phone from Copse on the desktop' })
          return
        }
        failedAuth.delete(peer)
        if (req.method === 'GET' && path.pathname === '/api/activity') {
          send(res, 200, { rows: await MOBILE_READ_DISPATCH.activity(), refreshedAt: Date.now() })
          return
        }
        const match = /^\/api\/thread\/([^/]+)\/([^/]+)$/.exec(path.pathname)
        const projectId = match?.[1] ?? ''
        const threadId = match?.[2] ?? ''
        if (
          req.method === 'GET' &&
          idPattern.test(projectId) &&
          idPattern.test(threadId) &&
          match
        ) {
          const thread = await MOBILE_READ_DISPATCH.thread(projectId, threadId)
          send(res, thread ? 200 : 404, thread ?? { error: 'Thread unavailable' })
          return
        }
        send(res, 404, { error: 'Not found' })
      })().catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'Request failed' })
        else res.destroy()
      })
    },
  )
  server.maxConnections = 8
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.timeout = 15_000
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    pairings.clear()
    server.closeAllConnections()
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )
    options.onStop?.()
  }
  server.on('error', () => {
    void stop()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(MOBILE_PORT, options.address, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const bound = server.address()
    if (!bound || typeof bound === 'string')
      throw new Error('Mobile Companion listener has no address')
    authority = `${options.address}:${String(bound.port)}`
    origin = `https://${authority}`
    return {
      url: origin,
      rootPath: identity.rootPath,
      devices: options.devices,
      isRunning: () => !stopped,
      close: stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}
