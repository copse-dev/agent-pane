import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { isPrivateOrLinkLocalHost } from '@copse/llm/credential-url.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { mobileAssetRoutes, mobileResponseHeaders } from '../../../shared/mobile-asset-routes.ts'
import { MobileActionRequests, mobileActionSchema, performMobileAction } from './mobile-actions.ts'
import {
  mobileActivity,
  mobileThread,
  mobileThreadImage,
  mobileProjects,
} from './mobile-activity.ts'
import { mobileCertificate } from './mobile-certificate.ts'
import { MobileDevices } from './mobile-devices.ts'
import { ClientPairings } from '../clients/client-pairings.ts'
import { clientLabelSchema, type ClientAccess } from '../../../shared/client-auth.ts'

/** The complete data surface available to a paired phone. */
export const MOBILE_READ_DISPATCH = Object.freeze({
  activity: mobileActivity,
  thread: mobileThread,
  threadImage: mobileThreadImage,
})

/** A stable origin preserves the phone's paired token across Copse restarts. */
export const MOBILE_PORT = 42773
const pairSchema = z.strictObject({ label: clientLabelSchema })
const idPattern = /^[\w-]{1,128}$/

export interface MobileLanAddress {
  address: string
  interfaceName: string
}

/** Keep interface identity: laptops commonly have Wi-Fi, VPN and VM addresses. */
export function mobileLanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): MobileLanAddress[] {
  return Object.entries(interfaces).flatMap(([interfaceName, entries]) =>
    (entries ?? []).flatMap((entry) =>
      entry.family === 'IPv4' && !entry.internal && isRfc1918(entry.address)
        ? [{ address: entry.address, interfaceName }]
        : [],
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

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, mobileResponseHeaders('application/json; charset=utf-8'))
  res.end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let length = 0
  try {
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) return null
      length += chunk.length
      if (length > maxBytes) return null
      chunks.push(chunk)
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks).toString('utf8')
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
  approvePair: (label: string, code: string, signal: AbortSignal) => Promise<ClientAccess | null>
  assetsDir?: string
  onDevicesChanged?: () => void
  onStop?: () => void
}): Promise<MobileServer> {
  if (!mobileLanAddresses().some((candidate) => candidate.address === options.address))
    throw new Error('Choose an active private IPv4 interface')
  const identity = mobileCertificate(options.address)
  const assets = options.assetsDir ?? join(__dirname, '..', 'mobile')
  const files = mobileAssetRoutes()
  // Read once, before binding, so a missing package asset cannot yield a
  // half-working listener. The map is fixed and contains no user path.
  const staticFiles = new Map(
    [...files].map(([route, file]) => {
      const body = readFileSync(join(assets, file.path))
      const etag = `"${createHash('sha256').update(body).digest('base64url')}"`
      return [route, { body, etag, headers: { ...file.headers, ETag: etag } }]
    }),
  )
  const actions = new MobileActionRequests(randomUUID())
  const failedAuth = new Map<string, { attempts: number; blockedUntil: number }>()
  let stopped = false
  const active = (): boolean => !stopped
  const pairings = new ClientPairings({
    maxPending: 1,
    canIssue: (): boolean => !stopped,
    issue: (label, access): { id: string; token: string } => {
      const issued = options.devices.issue(label, access)
      options.onDevicesChanged?.()
      return issued
    },
    revoke: (id): void => {
      options.devices.revoke(id)
      options.onDevicesChanged?.()
    },
    approve: options.approvePair,
  })
  let authority = ''
  let origin = ''
  const server: Server = createServer(
    { key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' },
    (req, res) => {
      void (async (): Promise<void> => {
        if (!active() || !mobileRequestAllowed(req, authority, origin)) {
          send(res, 403, { error: 'Forbidden' })
          return
        }
        const path = new URL(req.url ?? '/', origin)
        if (req.method === 'GET') {
          const file = staticFiles.get(path.pathname)
          if (file) {
            if (req.headers['if-none-match'] === file.etag) {
              res.writeHead(304, file.headers)
              res.end()
              return
            }
            res.writeHead(200, file.headers)
            res.end(file.body)
            return
          }
        }
        if (req.method === 'POST' && path.pathname === '/api/pair/request') {
          const raw = await readBody(req, 1024)
          const body = raw === null ? null : safeJsonParse(raw, decodeWithSchema(pairSchema))
          if (!body) {
            send(res, 400, { error: 'Invalid pairing request' })
            return
          }
          if (!active()) {
            send(res, 403, { error: 'Mobile Companion stopped' })
            return
          }
          const pairing = pairings.request(body.label, req.socket.remoteAddress)
          if (!pairing) {
            send(res, 429, { error: 'Pairing already in progress' })
            return
          }
          send(res, 200, pairing)
          return
        }
        if (req.method === 'GET' && path.pathname === '/api/pair/result') {
          const id = path.searchParams.get('id') ?? ''
          const pairing = pairings.poll(id, req.socket.remoteAddress)
          if (!pairing) {
            send(res, 404, { error: 'Pairing expired' })
            return
          }
          send(res, 200, pairing.state === 'pending' ? { state: 'waiting' } : pairing)
          return
        }
        // The bearer check precedes every protected body read and store access.
        const peer = req.socket.remoteAddress ?? ''
        const prior = failedAuth.get(peer)
        if (prior && prior.blockedUntil > Date.now()) {
          send(res, 429, { error: 'Too many failed requests' })
          return
        }
        const principal = options.devices.principal(req.headers.authorization)
        if (!principal) {
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
        if (req.method === 'POST' && path.pathname === '/api/action') {
          if (principal.access !== 'control') {
            send(res, 403, {
              error:
                'Enable control for this phone in Settings → Experimental → Mobile Companion on the Mac.',
            })
            return
          }
          const raw = await readBody(req, 4_300_000)
          const action =
            raw === null ? null : safeJsonParse(raw, decodeWithSchema(mobileActionSchema))
          if (!action) {
            send(res, 400, { error: 'Invalid action.' })
            return
          }
          const stillAuthorized = (): boolean =>
            !stopped && options.devices.principal(req.headers.authorization, 'control') !== null
          if (!stillAuthorized()) {
            send(res, 403, { error: 'Phone control was disabled.' })
            return
          }
          const result = await actions.run(action, principal, () =>
            performMobileAction(action, principal, stillAuthorized),
          )
          send(res, result.status, result.body)
          return
        }
        if (req.method === 'GET' && path.pathname === '/api/activity') {
          send(res, 200, {
            rows: await MOBILE_READ_DISPATCH.activity(),
            projects: mobileProjects(),
            refreshedAt: Date.now(),
            access: principal.access,
            sessionId: actions.sessionId,
          })
          return
        }
        const imageMatch = /^\/api\/thread\/([^/]+)\/([^/]+)\/image\/([^/]+)\/(\d+)$/.exec(
          path.pathname,
        )
        const imageProjectId = imageMatch?.[1] ?? ''
        const imageThreadId = imageMatch?.[2] ?? ''
        const imageMessageId = imageMatch?.[3] ?? ''
        if (
          req.method === 'GET' &&
          imageMatch &&
          idPattern.test(imageProjectId) &&
          idPattern.test(imageThreadId) &&
          idPattern.test(imageMessageId)
        ) {
          const image = await MOBILE_READ_DISPATCH.threadImage(
            imageProjectId,
            imageThreadId,
            imageMessageId,
            Number(imageMatch[4]),
          )
          send(res, image ? 200 : 404, image ? { image } : { error: 'Image unavailable' })
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
          send(
            res,
            thread ? 200 : 404,
            thread
              ? { ...thread, access: principal.access, sessionId: actions.sessionId }
              : { error: 'Thread unavailable' },
          )
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
  server.timeout = 75_000
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    pairings.close()
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
