import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  clientPairSchema,
  clientDecisionSchema,
  type ClientSnapshot,
} from '../../../shared/plugin-client-protocol.ts'
import type { HumanDecisions } from '../human-decisions.ts'

interface Pairing {
  label: string
  origin: string | undefined
  controller: AbortController
  expires: number
  state: 'pending' | 'denied' | 'approved'
  token?: string
}
interface Client {
  id: string
  label: string
  origin: string | undefined
  access: 'read' | 'control'
}

/** Loopback browser clients must be local, and every paired token is bound to its origin. */
function localOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (
      url.origin === origin &&
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Boolean(url.port)
    )
  } catch {
    return false
  }
}
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Session-only, interactive-client transport. No renderer IPC or agent-runtime entry point. */
export async function startPluginClientServer(options: {
  decisions: HumanDecisions
  enabled: () => boolean
  approvePair: (
    label: string,
    code: string,
    signal: AbortSignal,
  ) => Promise<'read' | 'control' | null>
}): Promise<{ origin: string; close: () => Promise<void> }> {
  let authority = ''
  let stopped = false
  const active = (): boolean => !stopped && options.enabled()
  const pairings = new Map<string, Pairing>()
  const clients = new Map<string, Client>()
  const streams = new Set<ServerResponse>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const deliveries = new Map<
    string,
    { fingerprint: string; result: { ok: boolean; reason: string } }
  >()
  let lastPair = 0

  function json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify(value))
  }
  function snapshot(client: Client): ClientSnapshot {
    const state = options.decisions.snapshot()
    return {
      version: 1,
      sessionId: state.sessionId,
      sequence: state.sequence,
      canRespond: client.access === 'control',
      requests: state.requests.flatMap(
        ({ projectId, threadId, revision, decision, interactiveClientSupported }) =>
          decision.kind === 'approval' && interactiveClientSupported
            ? [
                {
                  projectId,
                  threadId,
                  revision,
                  requestId: decision.id,
                  title: decision.title,
                  body: decision.body,
                  ...(decision.advice === undefined ? {} : { advice: decision.advice }),
                  ...(decision.footer === undefined ? {} : { footer: decision.footer }),
                },
              ]
            : [],
      ),
    }
  }
  function publish(res: ServerResponse, client: Client): void {
    if (!active()) {
      res.end()
      return
    }
    const data = JSON.stringify(snapshot(client))
    // Never silently truncate the meaning of an approval, or queue behind a slow reader.
    if (Buffer.byteLength(data) > 1024 * 1024 || !res.write(`data: ${data}\n\n`)) res.destroy()
  }
  async function body(req: IncomingMessage): Promise<string> {
    if (req.headers['content-type'] !== 'application/json') throw new Error('Expected JSON')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid request body')
      chunks.push(chunk)
      length += chunk.length
      if (length > 16_384) throw new Error('Request too large')
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 400, { error: 'Invalid request' })
      else res.destroy()
    })
  })
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin
    if (!active()) {
      json(res, 403, { error: 'Client API disabled' })
      return
    }
    if (
      req.headers.host !== authority ||
      !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
      (origin !== undefined && !localOrigin(origin))
    ) {
      json(res, 403, { error: 'Local clients only' })
      return
    }
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    const path = req.url
    if (req.method === 'POST' && path === '/v1/pair') {
      for (const [id, pairing] of pairings)
        if (pairing.expires < Date.now()) {
          pairing.controller.abort()
          pairings.delete(id)
        }
      const input = safeJsonParse(await body(req), decodeWithSchema(clientPairSchema))
      if (!input) {
        json(res, 400, { error: 'Invalid pairing request' })
        return
      }
      // Requests can overlap while their bodies arrive. Recheck authority and limits
      // immediately before creating a prompt, with no await between check and insert.
      if (!active()) {
        json(res, 403, { error: 'Client API disabled' })
        return
      }
      if (pairings.size >= 4 || Date.now() - lastPair < 1000 || clients.size >= 16) {
        json(res, 429, { error: 'Too many clients or pairing requests' })
        return
      }
      lastPair = Date.now()
      const id = randomUUID(),
        code = String(randomInt(100000, 1000000))
      const pairing: Pairing = {
        label: input.label,
        origin,
        controller: new AbortController(),
        expires: Date.now() + 120_000,
        state: 'pending',
      }
      pairings.set(id, pairing)
      json(res, 202, { version: 1, id, code })
      const timeout = setTimeout(() => {
        pairing.controller.abort()
        pairings.delete(id)
      }, 120_000)
      timeout.unref()
      timers.add(timeout)
      void options
        .approvePair(input.label, code, pairing.controller.signal)
        .then((access) => {
          if (
            stopped ||
            !options.enabled() ||
            pairing.controller.signal.aborted ||
            pairings.get(id) !== pairing
          )
            return
          if (access === null) {
            pairing.state = 'denied'
            return
          }
          const token = randomBytes(32).toString('hex')
          clients.set(tokenHash(token), { id: randomUUID(), label: input.label, origin, access })
          pairing.token = token
          pairing.state = 'approved'
        })
        .catch(() => {
          pairing.state = 'denied'
        })
        .finally(() => {
          clearTimeout(timeout)
          timers.delete(timeout)
        })
      return
    }
    if (req.method === 'GET' && path?.startsWith('/v1/pair/')) {
      const pairing = pairings.get(path.slice('/v1/pair/'.length))
      if (!pairing || pairing.origin !== origin || pairing.expires < Date.now()) {
        json(res, 404, { error: 'Pairing expired' })
        return
      }
      json(res, 200, {
        version: 1,
        state: pairing.state,
        ...(pairing.token ? { token: pairing.token } : {}),
      })
      if (pairing.state !== 'pending') pairings.delete(path.slice('/v1/pair/'.length))
      return
    }
    const authorization = req.headers.authorization
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    const client = /^[a-f0-9]{64}$/.test(token) ? clients.get(tokenHash(token)) : undefined
    if (!client || client.origin !== origin) {
      json(res, 401, { error: 'Pair in Copse first' })
      return
    }
    if (req.method === 'GET' && path === '/v1/events') {
      if (streams.size >= 16) {
        json(res, 429, { error: 'Too many subscriptions' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      streams.add(res)
      const unsubscribe = options.decisions.subscribe(() => {
        publish(res, client)
      })
      const heartbeat = setInterval(() => {
        if (options.enabled()) res.write(': heartbeat\n\n')
        else res.end()
      }, 1000)
      heartbeat.unref()
      res.on('close', () => {
        unsubscribe()
        clearInterval(heartbeat)
        streams.delete(res)
      })
      return
    }
    if (req.method === 'POST' && path === '/v1/decisions') {
      if (client.access !== 'control') {
        json(res, 403, { error: 'Viewing permission only' })
        return
      }
      const input = safeJsonParse(await body(req), decodeWithSchema(clientDecisionSchema))
      if (!input) {
        json(res, 400, { error: 'Invalid decision' })
        return
      }
      // An awaited request body must never carry authority across a disable.
      if (!active()) {
        json(res, 403, { error: 'Client API disabled' })
        return
      }
      const key = `${client.id}:${input.submissionId}`,
        fingerprint = JSON.stringify(input)
      const previous = deliveries.get(key)
      if (previous) {
        json(
          res,
          previous.fingerprint === fingerprint ? 200 : 409,
          previous.fingerprint === fingerprint
            ? previous.result
            : { error: 'Submission ID reused' },
        )
        return
      }
      if (deliveries.size >= 1000) {
        json(res, 429, { error: 'Session decision limit reached; disable and re-enable the API' })
        return
      }
      const supported = options.decisions
        .snapshot()
        .requests.some(
          (entry) =>
            entry.decision.id === input.requestId && entry.interactiveClientSupported === true,
        )
      const ok =
        supported &&
        options.decisions.respond(
          input,
          { kind: 'approval', approved: input.approved },
          { id: client.id, label: client.label, source: 'plugin-client' },
        )
      const result = {
        ok,
        reason: ok
          ? input.approved
            ? 'Approved once'
            : 'Denied'
          : 'Request changed or was answered elsewhere',
      }
      deliveries.set(key, { fingerprint, result })
      json(res, 200, result)
      return
    }
    json(res, 404, { error: 'Unknown operation' })
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing client API address')
  authority = `127.0.0.1:${String(address.port)}`
  return {
    origin: `http://${authority}`,
    close: async (): Promise<void> => {
      stopped = true
      clients.clear()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const pairing of pairings.values()) pairing.controller.abort()
      pairings.clear()
      for (const stream of streams) stream.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
