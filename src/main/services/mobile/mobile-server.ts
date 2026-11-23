import { randomUUID } from 'node:crypto'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import type { Duplex } from 'node:stream'
import { createSecureContext, type SecureContext } from 'node:tls'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { isPrivateOrLinkLocalHost } from '@copse/llm/credential-url.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { mobileResponseHeaders, shellFramableHeaders } from '../../../shared/mobile-asset-routes.ts'
import { remoteScopeFromQuery } from '../../../shared/remote-interface.ts'
import {
  assetResponse,
  entityTag,
  jsonResponse,
  textResponse,
  type RequestPreferences,
  type ResponseSpec,
} from './http-response.ts'
import { MobileActionRequests, mobileActionSchema, performMobileAction } from './mobile-actions.ts'
import {
  mobileActivity,
  mobileThread,
  mobileThreadImage,
  mobileProjects,
} from './mobile-activity.ts'
import { FailedAuthLimiter } from './failed-auth-limiter.ts'
import { mobileCertificate } from './mobile-certificate.ts'
import type { PairingVia } from './mobile-pairing.ts'
import { createRelayIngress } from './relay-ingress.ts'
import { MobileDevices } from './mobile-devices.ts'
import { loadPageAssets } from './page-assets.ts'
import { loadRemoteAssets } from './remote-assets.ts'
import { remoteInterface } from './remote-interface.ts'
import { remoteHttp } from './remote-http.ts'
import { isVirtualInterface } from './default-route.ts'
import { ClientPairings } from '../clients/client-pairings.ts'
import type { PublicIdentity } from '../remote-names/names-service.ts'
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
  /** A VM bridge or VPN tunnel: a phone on the local network almost never reaches it. */
  virtual: boolean
}

/**
 * Keep interface identity: laptops commonly have Wi-Fi, VPN and VM addresses.
 * The default-route interface comes first, then other physical interfaces,
 * then virtual ones, so the first entry is the sensible default.
 */
export function mobileLanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  defaultInterface: string | null = null,
): MobileLanAddress[] {
  const rank = (candidate: MobileLanAddress): number =>
    candidate.interfaceName === defaultInterface ? 0 : candidate.virtual ? 2 : 1
  return Object.entries(interfaces)
    .flatMap(([interfaceName, entries]) =>
      (entries ?? []).flatMap((entry) =>
        entry.family === 'IPv4' && !entry.internal && isRfc1918(entry.address)
          ? [{ address: entry.address, interfaceName, virtual: isVirtualInterface(interfaceName) }]
          : [],
      ),
    )
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
    .map(({ candidate }) => candidate)
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

/**
 * Reject DNS rebinding, cross-origin calls, and public peers before any route
 * dispatch. `Host` must be exactly one of `authorities`: the bound `ip:port`
 * literal, and, when this Mac has one, its trusted `lan.<label>.u.copse.me:port`
 * name. That name is safe here because only this Mac's device key can point it
 * anywhere, and the names service publishes nothing but private addresses for
 * it. `Origin` must be the origin of the authority the request named.
 */
export function mobileRequestAllowed(
  req: IncomingMessage,
  authorities: readonly string[],
): boolean {
  const peer = req.socket.remoteAddress
  if (!peer || !isPrivateOrLinkLocalHost(peer)) return false
  const host = req.headers.host
  if (host === undefined || !authorities.includes(host)) return false
  const origin = `https://${host}`
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false
  if (req.method !== 'GET' && req.headers.origin !== origin) return false
  return true
}

/**
 * The boundary for a request that arrived through the Copse relay. There is no
 * private peer to check: the relay admits only source addresses that a
 * copse.me account paired with this Mac refreshed in the last few minutes.
 * `Host` must be exactly this Mac's `web.<label>.u.copse.me` (browsers omit
 * the default port) and `Origin` its origin. Every route past pairing still
 * needs a device token, and pairing still needs the desktop's approval.
 */
export function relayedRequestAllowed(req: IncomingMessage, hostname: string): boolean {
  if (req.headers.host !== hostname) return false
  const origin = `https://${hostname}`
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false
  if (req.method !== 'GET' && req.headers.origin !== origin) return false
  return true
}

const JSON_HEADERS = mobileResponseHeaders('application/json; charset=utf-8')

/** Responses served under a trusted name, which only the copse.me shell may frame. */
const shellFramed = new WeakSet<ServerResponse>()

function headersFor(res: ServerResponse, headers: Record<string, string>): Record<string, string> {
  return shellFramed.has(res) ? shellFramableHeaders(headers) : headers
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, headersFor(res, JSON_HEADERS))
  res.end(JSON.stringify(value))
}

function write(res: ServerResponse, spec: ResponseSpec): void {
  res.writeHead(spec.status, headersFor(res, spec.headers))
  res.end(spec.body ?? undefined)
}

/** How a request that passed its transport's boundary check arrived. */
interface RequestRoute extends PairingVia {
  /** Who failed-token limits are keyed to. */
  peer: string
  /**
   * Who may collect a pairing result. On the LAN, the peer address. Through the relay, any
   * relayed client holding the pairing's random id: the id is returned only to the requester
   * over TLS, and the address the relay reports can change between a phone's request and its
   * polls (carrier NAT, IPv4 and IPv6).
   */
  binding: string
}

function preferences(req: IncomingMessage): RequestPreferences {
  return {
    acceptEncoding: req.headers['accept-encoding'],
    ifNoneMatch: req.headers['if-none-match'],
  }
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
  address: string
  port: number
  rootPath: string
  devices: MobileDevices
  isRunning(): boolean
  /**
   * Serve one browser connection that reached this Mac through the Copse
   * relay: its TLS bytes from the ClientHello on, completed here with the
   * trusted name's certificate.
   */
  acceptRelayed(stream: Duplex, clientIp: string): void
  close(): Promise<void>
}

export async function startMobileServer(options: {
  address: string
  devices: MobileDevices
  approvePair: (
    label: string,
    code: string,
    signal: AbortSignal,
    via: PairingVia,
  ) => Promise<ClientAccess | null>
  /** The publicly trusted name and certificate to serve beside the LAN IP, while valid. */
  publicIdentity?: () => PublicIdentity | null
  /**
   * Whether the copse.me shell may frame responses under the trusted name: only while the
   * user has chosen to be reachable through the relay. Otherwise every response keeps
   * `frame-ancestors 'none'` (or `'self'` for the diagram frame).
   */
  shellFraming?: () => boolean
  assetsDir?: string
  onDevicesChanged?: () => void
  onStop?: () => void
}): Promise<MobileServer> {
  if (!mobileLanAddresses().some((candidate) => candidate.address === options.address))
    throw new Error('Choose an active private IPv4 interface')
  const identity = mobileCertificate(options.address)
  const assets = options.assetsDir ?? join(__dirname, '..', 'mobile')
  // Read once, before binding, so a missing package asset cannot yield a
  // half-working listener. The map is fixed and contains no user path.
  const staticFiles = await loadPageAssets(assets)
  const remoteAssets = await loadRemoteAssets(join(assets, 'remote'))
  // The live state is the same object until the desktop publishes again, and a
  // phone polls it far more often than that: serialize each one once.
  const serializedStates = new WeakMap<object, { text: string; etag: string }>()
  const actions = new MobileActionRequests(randomUUID())
  const failedAuth = new FailedAuthLimiter()
  let stopped = false
  const active = (): boolean => !stopped
  // One pending pairing per transport, so a client the relay admits cannot hold the only
  // slot and keep a phone on the local network from pairing.
  const newPairings = (): ClientPairings =>
    new ClientPairings({
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
      approve: (label, code, signal, context): Promise<ClientAccess | null> =>
        options.approvePair(label, code, signal, {
          trustedName: context?.trustedName === true,
          relayed: context?.relayed === true,
        }),
    })
  const pairings = newPairings()
  const relayPairings = newPairings()

  let authority = ''
  let port = 0
  // The trusted name, when there is one, is served by SNI: a phone that opens
  // the bare IP sends no server name and gets the local-root certificate.
  let sniCache: { identity: PublicIdentity; context: SecureContext } | null = null
  const publicIdentity = (): PublicIdentity | null => options.publicIdentity?.() ?? null
  const authorities = (): string[] => {
    const name = publicIdentity()?.hostname
    return name ? [authority, `${name}:${String(port)}`] : [authority]
  }
  const server: Server = createServer(
    {
      key: identity.key,
      cert: identity.cert,
      minVersion: 'TLSv1.2',
      SNICallback: (servername, done): void => {
        const current = publicIdentity()
        if (!current || servername !== current.hostname) {
          done(null, undefined)
          return
        }
        try {
          if (sniCache?.identity !== current)
            sniCache = {
              identity: current,
              context: createSecureContext({
                key: current.key,
                cert: current.cert,
                minVersion: 'TLSv1.2',
              }),
            }
          done(null, sniCache.context)
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)), undefined)
        }
      },
    },
    (req, res) => {
      serve(req, res, () =>
        mobileRequestAllowed(req, authorities())
          ? {
              peer: req.socket.remoteAddress ?? '',
              binding: req.socket.remoteAddress ?? '',
              trustedName: req.headers.host !== authority,
              relayed: false,
            }
          : null,
      )
    },
  )
  const relayed = createRelayIngress({
    identity: publicIdentity,
    handle: (req, res, clientIp) => {
      serve(req, res, () => {
        const web = publicIdentity()?.web
        return web && relayedRequestAllowed(req, web)
          ? { peer: `relay ${clientIp}`, binding: 'relay', trustedName: true, relayed: true }
          : null
      })
    },
  })
  function serve(
    req: IncomingMessage,
    res: ServerResponse,
    admit: () => RequestRoute | null,
  ): void {
    void (async (): Promise<void> => {
      const route = active() ? admit() : null
      if (!route) {
        send(res, 403, { error: 'Forbidden' })
        return
      }
      if (route.trustedName && options.shellFraming?.() === true) shellFramed.add(res)
      await handle(req, res, route)
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'Request failed' })
      else res.destroy()
    })
  }
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    route: RequestRoute,
  ): Promise<void> {
    const origin = `https://${req.headers.host ?? authority}`
    const path = new URL(req.url ?? '/', origin)
    // Polled reads carry a validator and a negotiated coding: an unchanged
    // answer is a bodiless 304, and a changed one travels compressed.
    const reply = async (status: number, value: unknown, etag?: string | true): Promise<void> => {
      write(res, await jsonResponse(JSON_HEADERS, status, value, preferences(req), etag))
    }
    if (req.method === 'GET') {
      const file = staticFiles.get(path.pathname) ?? remoteAssets.get(path.pathname)
      if (file) {
        write(
          res,
          await assetResponse(file, {
            ...preferences(req),
            version: path.searchParams.get('v'),
          }),
        )
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
      const slot = route.relayed ? relayPairings : pairings
      const pairing = slot.request(body.label, route.binding, {
        trustedName: route.trustedName,
        relayed: route.relayed,
      })
      if (!pairing) {
        send(res, 429, { error: 'Pairing already in progress' })
        return
      }
      send(res, 200, pairing)
      return
    }
    // Never compressed: this answer carries a bearer token (BREACH).
    if (req.method === 'GET' && path.pathname === '/api/pair/result') {
      const id = path.searchParams.get('id') ?? ''
      const pairing = (route.relayed ? relayPairings : pairings).poll(id, route.binding)
      if (!pairing) {
        send(res, 404, { error: 'Pairing expired' })
        return
      }
      send(res, 200, pairing.state === 'pending' ? { state: 'waiting' } : pairing)
      return
    }
    // The bearer check precedes every protected body read and store access.
    const peer = route.peer
    if (failedAuth.blocked(peer)) {
      send(res, 429, { error: 'Too many failed requests' })
      return
    }
    const principal = options.devices.principal(req.headers.authorization)
    if (!principal) {
      failedAuth.failed(peer)
      send(res, 401, { error: 'Pair this phone from Copse on the desktop' })
      return
    }
    failedAuth.succeeded(peer)
    if (
      (req.method === 'GET' && path.pathname === '/api/remote/state') ||
      (req.method === 'POST' && path.pathname === '/api/remote/read')
    ) {
      const authorized = (): boolean =>
        active() && options.devices.principal(req.headers.authorization, 'control') !== null
      // Check control before reading a body, then again when the desktop replies.
      if (!authorized()) {
        send(res, 403, { error: 'Enable control for this phone on the Mac.' })
        return
      }
      const body = req.method === 'POST' ? await readBody(req, 262_144) : undefined
      const scope = req.method === 'GET' ? remoteScopeFromQuery(path.searchParams) : undefined
      if (body === null || scope === null) {
        send(res, 400, { error: 'Invalid remote request.' })
        return
      }
      const result = await remoteHttp(remoteInterface, authorized, body, scope)
      const state = req.method === 'GET' && result.status === 200 ? result.body : null
      let spec: ResponseSpec
      if (typeof state === 'object' && state !== null) {
        let serialized = serializedStates.get(state)
        if (!serialized) {
          const text = JSON.stringify(state)
          serialized = { text, etag: entityTag(text) }
          serializedStates.set(state, serialized)
        }
        spec = await textResponse(
          JSON_HEADERS,
          200,
          serialized.text,
          preferences(req),
          serialized.etag,
        )
      } else {
        spec = await jsonResponse(JSON_HEADERS, result.status, result.body, preferences(req))
      }
      // Encoding is asynchronous: control may have been revoked since remoteHttp checked.
      if (result.status === 200 && !authorized()) {
        send(res, 403, { error: 'Phone control was disabled.' })
        return
      }
      write(res, spec)
      return
    }
    if (req.method === 'POST' && path.pathname === '/api/action') {
      if (principal.access !== 'control') {
        send(res, 403, {
          error:
            'Enable control for this phone in Settings → Experimental → Mobile Companion on the Mac.',
        })
        return
      }
      const raw = await readBody(req, 4_300_000)
      const action = raw === null ? null : safeJsonParse(raw, decodeWithSchema(mobileActionSchema))
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
      const feed = {
        rows: await MOBILE_READ_DISPATCH.activity(),
        projects: mobileProjects(),
        access: principal.access,
        sessionId: actions.sessionId,
      }
      // `refreshedAt` moves on every poll; the validator covers the rest, so
      // a quiet desktop answers 304 and the phone keeps the list it has.
      await reply(200, { ...feed, refreshedAt: Date.now() }, entityTag(JSON.stringify(feed)))
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
      // Base64 gives back about a quarter of its size to the response coding.
      await reply(image ? 200 : 404, image ? { image } : { error: 'Image unavailable' })
      return
    }
    const match = /^\/api\/thread\/([^/]+)\/([^/]+)$/.exec(path.pathname)
    const projectId = match?.[1] ?? ''
    const threadId = match?.[2] ?? ''
    if (req.method === 'GET' && idPattern.test(projectId) && idPattern.test(threadId) && match) {
      const thread = await MOBILE_READ_DISPATCH.thread(projectId, threadId)
      if (!thread) {
        send(res, 404, { error: 'Thread unavailable' })
        return
      }
      await reply(200, { ...thread, access: principal.access, sessionId: actions.sessionId }, true)
      return
    }
    send(res, 404, { error: 'Not found' })
  }
  server.maxConnections = 8
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.timeout = 75_000
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    pairings.close()
    relayPairings.close()
    relayed.close()
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
    port = bound.port
    authority = `${options.address}:${String(port)}`
    return {
      url: `https://${authority}`,
      address: options.address,
      port,
      rootPath: identity.rootPath,
      devices: options.devices,
      isRunning: () => !stopped,
      acceptRelayed: (stream, clientIp): void => {
        relayed.accept(stream, clientIp)
      },
      close: stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}
