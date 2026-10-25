import { clientActionSubmissionSchema } from '@shared/client-actions.ts'
import type { ClientActions } from '../clients/client-actions.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  clientPairSchema,
  clientDecisionSchema,
  clientQuestionAnswerSchema,
  clientActivityDataSchema,
  clientOpenThreadSchema,
  clientReadThreadSchema,
  clientThreadTextSchema,
  type ClientThreadText,
  type ClientActivityData,
  type ClientSnapshot,
} from '../../../shared/plugin-client-protocol.ts'
import type { HumanDecisions } from '../human-decisions.ts'
import { ClientCredentials } from '../clients/client-credentials.ts'
import { ClientPairings } from '../clients/client-pairings.ts'

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

/** Session-only, interactive-client transport. No renderer IPC or agent-runtime entry point. */
export async function startPluginClientServer(options: {
  decisions: HumanDecisions
  enabled: () => boolean
  actions?: ClientActions
  activity?: { read: (fresh?: boolean) => Promise<ClientActivityData> }
  readThread?: (projectId: string, threadId: string) => Promise<ClientThreadText>
  openThread?: (projectId: string, threadId: string) => boolean
  approvePair: (label: string, code: string, signal: AbortSignal) => Promise<boolean>
}): Promise<{ origin: string; close: () => Promise<void> }> {
  let authority = ''
  let stopped = false
  const active = (): boolean => !stopped && options.enabled()
  const clients = new ClientCredentials()
  const pairings = new ClientPairings({
    maxPending: 4,
    canIssue: (): boolean => active() && clients.list().length < 16,
    issue: (label, access, binding): { id: string; token: string } =>
      clients.issue(label, access, binding),
    revoke: (id): void => {
      clients.revoke(id)
    },
    approve: async (label, code, signal): Promise<'control' | null> =>
      (await options.approvePair(label, code, signal)) ? 'control' : null,
  })
  let contentReads = 0
  let activitySequence = 0
  let activityFingerprint = ''
  const streams = new Set<ServerResponse>()
  const actionDeliveries = new Map<
    string,
    { fingerprint: string; result: Promise<{ ok: boolean; reason: string }> }
  >()
  const deliveries = new Map<
    string,
    { fingerprint: string; result: { ok: boolean; reason: string } }
  >()

  function json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify(value))
  }
  function snapshot(): ClientSnapshot {
    const state = options.decisions.snapshot()
    return {
      version: 1,
      sessionId: state.sessionId,
      sequence: state.sequence,
      canRespond: true,
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
  function publish(res: ServerResponse): void {
    if (!active()) {
      res.end()
      return
    }
    const data = JSON.stringify(snapshot())
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
      const pairing = pairings.request(input.label, origin)
      if (!pairing) {
        json(res, 429, { error: 'Too many clients or pairing requests' })
        return
      }
      json(res, 202, { version: 1, ...pairing })
      return
    }
    if (req.method === 'GET' && path?.startsWith('/v1/pair/')) {
      const pairing = pairings.poll(path.slice('/v1/pair/'.length), origin)
      if (!pairing) {
        json(res, 404, { error: 'Pairing expired' })
        return
      }
      json(res, 200, { version: 1, ...pairing })
      return
    }
    const client = clients.principal(req.headers.authorization, origin, 'control')
    if (!client) {
      json(res, 401, { error: 'Pair in Copse first' })
      return
    }
    if (req.method === 'GET' && path === '/v1/actions') {
      json(res, 200, {
        version: 1,
        sessionId: options.decisions.snapshot().sessionId,
        offer:
          options.decisions.snapshot().requests.length === 0
            ? (options.actions?.snapshot() ?? null)
            : null,
      })
      return
    }
    if (req.method === 'GET' && path === '/v1/questions') {
      const state = options.decisions.snapshot()
      json(res, 200, {
        version: 1,
        sessionId: state.sessionId,
        sequence: state.sequence,
        requests: state.requests.flatMap(({ projectId, threadId, revision, decision }) =>
          decision.kind === 'question'
            ? [
                {
                  projectId,
                  threadId,
                  revision,
                  requestId: decision.id,
                  questions: decision.questions,
                },
              ]
            : [],
        ),
      })
      return
    }
    if (req.method === 'POST' && path === '/v1/actions') {
      const input = safeJsonParse(await body(req), decodeWithSchema(clientActionSubmissionSchema))
      if (!input) {
        json(res, 400, { error: 'Invalid action reference' })
        return
      }
      const authorized = (): boolean =>
        active() &&
        Boolean(clients.principal(req.headers.authorization, origin, 'control')) &&
        input.sessionId === options.decisions.snapshot().sessionId &&
        options.decisions.snapshot().requests.length === 0
      if (!authorized()) {
        json(res, 403, { error: 'Action unavailable' })
        return
      }
      const key = `${client.id}:${input.submissionId}`
      const fingerprint = JSON.stringify(input)
      const previous = actionDeliveries.get(key)
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          json(res, 409, { ok: false, reason: 'Conflicting action identity' })
          return
        }
        json(res, 200, await previous.result)
        return
      }
      const offer = options.actions?.snapshot()
      if (
        !offer ||
        offer.projectId !== input.projectId ||
        offer.threadId !== input.threadId ||
        offer.revision !== input.revision ||
        !offer.actions.some((action) => action.id === input.actionId)
      ) {
        json(res, 200, { ok: false, reason: 'Action changed or unavailable' })
        return
      }
      if (actionDeliveries.size >= 4096) {
        json(res, 429, { error: 'Too many submissions' })
        return
      }
      const result = (async (): Promise<{ ok: boolean; reason: string }> => {
        const ok = (await options.actions?.perform(input, authorized)) ?? false
        return { ok, reason: ok ? 'Action accepted in Copse' : 'Action changed or unavailable' }
      })()
      actionDeliveries.set(key, { fingerprint, result })
      json(res, 200, await result)
      return
    }
    if (req.method === 'GET' && path === '/v1/activity') {
      if (!options.activity) {
        json(res, 404, { error: 'Activity unavailable' })
        return
      }
      const data = clientActivityDataSchema.parse(await options.activity.read())
      if (!active() || !clients.principal(req.headers.authorization, origin, 'control')) {
        json(res, 403, { error: 'Client API disabled' })
        return
      }
      const fingerprint = JSON.stringify(data)
      if (fingerprint !== activityFingerprint) {
        activityFingerprint = fingerprint
        activitySequence++
      }
      json(res, 200, {
        version: 1,
        sessionId: options.decisions.snapshot().sessionId,
        sequence: activitySequence,
        ...data,
      })
      return
    }
    if (req.method === 'POST' && path === '/v1/threads/content') {
      const input = safeJsonParse(await body(req), decodeWithSchema(clientReadThreadSchema))
      if (!input) {
        json(res, 400, { error: 'Invalid thread reference' })
        return
      }
      const authorized = (): boolean =>
        active() && Boolean(clients.principal(req.headers.authorization, origin, 'control'))
      if (!authorized()) {
        json(res, 403, { error: 'Client API disabled' })
        return
      }
      if (!options.activity || !options.readThread) {
        json(res, 404, { error: 'Chat text unavailable' })
        return
      }
      if (contentReads >= 4) {
        json(res, 429, { error: 'Too many content reads' })
        return
      }
      contentReads++
      try {
        const eligible = async (): Promise<boolean> => {
          const activity = await options.activity?.read(true)
          return (
            activity?.recentThreads.some(
              (row) =>
                row.projectId === input.projectId &&
                row.threadId === input.threadId &&
                row.settledAt === input.settledAt,
            ) ?? false
          )
        }
        const known = await eligible()
        if (!authorized()) {
          json(res, 403, { error: 'Client API disabled' })
          return
        }
        if (!known) {
          json(res, 404, { error: 'Chat is no longer available' })
          return
        }
        const text = clientThreadTextSchema.parse(
          await options.readThread(input.projectId, input.threadId),
        )
        const stillKnown = await eligible()
        if (!authorized()) {
          json(res, 403, { error: 'Client API disabled' })
          return
        }
        if (!stillKnown) {
          json(res, 404, { error: 'Chat is no longer available' })
          return
        }
        json(res, 200, { ...input, sessionId: options.decisions.snapshot().sessionId, ...text })
      } finally {
        contentReads--
      }
      return
    }
    if (req.method === 'POST' && path === '/v1/threads/open') {
      const input = safeJsonParse(await body(req), decodeWithSchema(clientOpenThreadSchema))
      if (!input) {
        json(res, 400, { error: 'Invalid thread reference' })
        return
      }
      if (!active() || !clients.principal(req.headers.authorization, origin, 'control')) {
        json(res, 403, { error: 'Client API disabled' })
        return
      }
      const activity = options.activity ? await options.activity.read(true) : undefined
      if (!active() || !clients.principal(req.headers.authorization, origin, 'control')) {
        json(res, 403, { error: 'Client API disabled' })
        return
      }
      const known =
        (activity?.recentThreads.some(
          (row) => row.projectId === input.projectId && row.threadId === input.threadId,
        ) ??
          false) ||
        options.decisions
          .snapshot()
          .requests.some(
            (row) =>
              (row.interactiveClientSupported === true || row.decision.kind === 'question') &&
              row.projectId === input.projectId &&
              row.threadId === input.threadId,
          )
      if (!known || !options.openThread?.(input.projectId, input.threadId)) {
        json(res, 404, { ok: false, reason: 'Thread is no longer available' })
        return
      }
      json(res, 200, { ok: true, reason: 'Opening in Copse' })
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
        publish(res)
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
    if (req.method === 'POST' && (path === '/v1/decisions' || path === '/v1/questions')) {
      const text = await body(req)
      const input =
        path === '/v1/questions'
          ? safeJsonParse(text, decodeWithSchema(clientQuestionAnswerSchema))
          : safeJsonParse(text, decodeWithSchema(clientDecisionSchema))
      if (!input) {
        json(res, 400, { error: 'Invalid decision' })
        return
      }
      // An awaited request body must never carry authority across a disable.
      if (!active() || !clients.principal(req.headers.authorization, origin, 'control')) {
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
            entry.decision.id === input.requestId &&
            ('answers' in input
              ? entry.decision.kind === 'question'
              : entry.decision.kind === 'approval' && entry.interactiveClientSupported === true),
        )
      const ok =
        supported &&
        options.decisions.respond(
          input,
          'answers' in input
            ? { kind: 'question', answers: input.answers }
            : { kind: 'approval', approved: input.approved },
          { id: client.id, label: client.label, source: 'plugin-client' },
        )
      const result = {
        ok,
        reason: ok
          ? 'answers' in input
            ? 'Answers submitted'
            : input.approved
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
      pairings.close()
      clients.clear()
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
