import { randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { ClassifierError } from '@copse/llm/classifiers/error.ts'
import { classifierRequestSchema } from '@copse/llm/classifiers/schemas.ts'
import type {
  ClassifierProfile,
  ClassifierRequest,
  ClassifierResult,
} from '@copse/llm/classifiers/types.ts'
import {
  machineAddressSchema,
  machineSharingSchema,
  sharedModelSchema,
  type MachinesState,
  type MachineSharing,
  type SharedMachineModel,
  type PairedMachine,
} from '@shared/machines.ts'
import { createMachineCertificate } from '../mobile/mobile-certificate.ts'
import { machineStoreSchema, type MachineStore, type MachineStoreData } from './machine-store.ts'
import {
  decodeMachineInvitation,
  machineRequest,
  MachineConnectionError,
  type MachineConnectTarget,
} from './machine-transport.ts'

/**
 * Reaching a paired machine through a saved SSH host: a forward on that host's
 * multiplexed master to the machine's loopback listener.
 *
 * `interactive` is true only for work a person started (pairing, Test
 * classifier). Status checks and the classifier calls that screening and
 * background questions make pass false, so they never open a connection or
 * raise an SSH prompt (docs/plans/multi-machine-access.md decision 5).
 */
export interface MachineSshReach {
  open(
    hostId: string,
    remotePort: number,
    options: { interactive: boolean },
  ): Promise<{ target: MachineConnectTarget; close: () => Promise<void> }>
  /** The saved host's label, or null when it is no longer saved. */
  label(hostId: string): string | null
}

const LOOPBACK = '127.0.0.1'
const REMOVED_SSH_ROUTE =
  'The SSH machine this was reached through was removed. Pair it again to reach it.'

const describeSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(128),
  models: z.array(sharedModelSchema).max(64),
})
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
const pairSchema = z.strictObject({
  secret: tokenSchema,
  id: z.uuid(),
  name: z.string().min(1).max(128),
})
const commandSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('describe') }),
  z.strictObject({
    method: z.literal('evaluate'),
    profileId: sharedModelSchema.shape.id,
    request: classifierRequestSchema,
  }),
])
function matches(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
async function body(request: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const value of request) {
    const chunk: unknown = value
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid request.')
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('Request too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export class MachineManager {
  private data: MachineStoreData
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private outgoing = new Map<AbortController, string>()
  private writeQueue: Promise<unknown> = Promise.resolve()
  private invitationValue: { secret: string; expires: number; clientId: string | null } | null =
    null
  private active = new Map<AbortController, string>()
  private states = new Map<string, Pick<PairedMachine, 'status' | 'detail'>>()
  private sharingError: string | null = null
  private refreshing: Promise<void> | null = null
  private readonly store: MachineStore
  private readonly profiles: () => ClassifierProfile[]
  private readonly evaluate: (
    profileId: string,
    request: ClassifierRequest,
    signal: AbortSignal,
  ) => Promise<ClassifierResult>
  private readonly name: string
  private readonly reach: MachineSshReach | null
  constructor(
    store: MachineStore,
    profiles: () => ClassifierProfile[],
    evaluate: (
      profileId: string,
      request: ClassifierRequest,
      signal: AbortSignal,
    ) => Promise<ClassifierResult>,
    name = hostname().slice(0, 128),
    reach: MachineSshReach | null = null,
  ) {
    this.store = store
    this.profiles = profiles
    this.evaluate = evaluate
    this.name = name
    this.reach = reach
    this.data = store.load() ?? {
      version: 1,
      id: randomUUID(),
      identity: null,
      sharing: { enabled: false, address: '127.0.0.1', port: 4319, profileIds: [] },
      machines: [],
      clients: [],
    }
  }
  private assertEnabled(): void {
    if (!this.store.enabled())
      throw new ClassifierError(
        'unsupported-capability',
        'Enable Remote System One models in Settings → Experimental first.',
      )
  }
  private async request(
    machineId: string,
    ...args: Parameters<typeof machineRequest>
  ): Promise<unknown> {
    this.assertEnabled()
    const [endpoint, path, payload, options = {}] = args
    const controller = new AbortController()
    this.outgoing.set(controller, machineId)
    try {
      const result = await machineRequest(endpoint, path, payload, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
      })
      this.assertEnabled()
      controller.signal.throwIfAborted()
      return result
    } finally {
      this.outgoing.delete(controller)
    }
  }
  /**
   * Run `send` against the machine, through its SSH host's forward when it has
   * one. The forward lives only as long as the request. A route whose host was
   * removed (`null`) reaches nothing: its loopback endpoint would otherwise be
   * dialled on this computer.
   */
  private async viaRoute<T>(
    viaSshHost: string | null | undefined,
    remotePort: number,
    interactive: boolean,
    send: (connectTo: MachineConnectTarget | undefined) => Promise<T>,
  ): Promise<T> {
    if (viaSshHost === null) throw new MachineConnectionError(REMOVED_SSH_ROUTE)
    if (!viaSshHost) return send(undefined)
    if (!this.reach) throw new MachineConnectionError('SSH is not available in this Copse.')
    let opened: Awaited<ReturnType<MachineSshReach['open']>>
    try {
      opened = await this.reach.open(viaSshHost, remotePort, { interactive })
    } catch (error) {
      const label = this.reach.label(viaSshHost) ?? viaSshHost
      throw new MachineConnectionError(
        interactive
          ? `Could not reach this machine over SSH through ${label}: ${error instanceof Error ? error.message : String(error)}`
          : `Connect to ${label} over SSH to reach this machine.`,
      )
    }
    try {
      return await send(opened.target)
    } finally {
      await opened.close().catch(() => undefined)
    }
  }
  /** The SSH host a machine is reached through: undefined for none, null once it was removed. */
  private route(machineId: string): string | null | undefined {
    return this.store.routes()[machineId]
  }
  private change<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.writeQueue.then(action)
    this.writeQueue = pending.catch(() => undefined)
    return pending
  }
  private async save(next: MachineStoreData): Promise<void> {
    const parsed = machineStoreSchema.parse(next)
    await this.store.save(parsed)
    this.data = parsed
  }
  shareable(): SharedMachineModel[] {
    return this.profiles().flatMap((profile) => {
      const connection = profile.connection
      if (connection.type !== 'http' || connection.protocol !== 'systemone') return []
      const url = new URL(connection.baseUrl)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return []
      return [
        {
          id: profile.id,
          label: profile.label,
          model: profile.model,
          timeoutMs: profile.timeoutMs,
        },
      ]
    })
  }
  private describe(): z.infer<typeof describeSchema> {
    return {
      id: this.data.id,
      name: this.name,
      models: this.shareable().filter((model) => this.data.sharing.profileIds.includes(model.id)),
    }
  }
  snapshot(): MachinesState {
    const addresses = [
      { address: LOOPBACK, label: 'This computer only (reach it over SSH, or from this computer)' },
    ]
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (
          entry.family === 'IPv4' &&
          !entry.internal &&
          machineAddressSchema.safeParse(entry.address).success
        )
          addresses.push({ address: entry.address, label: `${name} · ${entry.address}` })
      }
    }
    return {
      featureEnabled: this.store.enabled(),
      machines: this.data.machines.map((peer) => {
        const via = this.route(peer.id)
        const viaLabel = via ? (this.reach?.label(via) ?? via) : null
        // The address already says the route's machine was removed.
        const unreachable: Pick<PairedMachine, 'status' | 'detail'> | null =
          via === null ? { status: 'unavailable', detail: 'Pair it again to reach it.' } : null
        return {
          id: peer.id,
          name: peer.name,
          address:
            via === null
              ? 'over SSH through a removed machine'
              : viaLabel
                ? `over SSH through ${viaLabel}`
                : peer.endpoint.address,
          ...(via && viaLabel ? { viaSsh: { hostId: via, label: viaLabel } } : {}),
          models: peer.models,
          ...(this.store.enabled()
            ? (unreachable ??
              this.states.get(peer.id) ?? {
                status: 'reconnecting',
                detail: 'Checking connection…',
              })
            : { status: 'unavailable', detail: 'Remote System One models are off.' }),
        }
      }),
      addresses,
      sharing: {
        ...this.data.sharing,
        listening: this.server?.listening === true,
        error: this.sharingError,
      },
      shareableModels: this.shareable(),
      clients: this.data.clients.map(({ id, name }) => ({ id, name })),
      secureStorage: this.store.available(),
    }
  }
  async restore(): Promise<void> {
    if (!this.store.enabled()) {
      await this.close()
      return
    }
    try {
      await this.change(async () => {
        if (this.store.enabled() && this.data.sharing.enabled && !this.server)
          await this.applySharing(this.data.sharing)
      })
    } catch {
      this.sharingError =
        'Sharing could not start. Check the selected network and secure storage, then try again.'
    }
  }
  private async closeListener(): Promise<void> {
    this.invitationValue = null
    for (const controller of this.active.keys()) controller.abort()
    const server = this.server
    this.server = null
    if (server) {
      const closed = new Promise<void>((resolve) =>
        server.close(() => {
          resolve()
        }),
      )
      server.closeAllConnections()
      for (const socket of this.sockets) socket.destroy()
      await closed
    }
  }
  async close(): Promise<void> {
    for (const controller of this.outgoing.keys()) controller.abort()
    for (const controller of this.active.keys()) controller.abort()
    await this.change(() => this.closeListener())
  }
  share(raw: MachineSharing): Promise<MachinesState> {
    return this.change(() => this.applySharing(raw))
  }
  private async applySharing(raw: MachineSharing): Promise<MachinesState> {
    const config = machineSharingSchema.parse(raw)
    if (!config.enabled) {
      await this.save({ ...this.data, sharing: config })
      await this.closeListener()
      this.sharingError = null
      return this.snapshot()
    }
    this.assertEnabled()
    if (!this.store.available()) throw new Error('Unlock secure storage before sharing models.')
    const available = this.shareable()
    if (
      !config.profileIds.length ||
      config.profileIds.some((id) => !available.some((model) => model.id === id))
    )
      throw new Error('Choose at least one saved local System One connection to share.')
    await this.closeListener()
    this.assertEnabled()
    const issued = this.data.identity ? null : createMachineCertificate()
    const identity =
      this.data.identity ??
      (issued ? { certificate: issued.cert, key: this.store.seal(issued.key) } : null)
    if (!identity) throw new Error('Machine identity unavailable.')
    const server = createServer(
      {
        key: this.store.open(identity.key),
        cert: identity.certificate,
        requestTimeout: 15_000,
        headersTimeout: 10_000,
        maxHeaderSize: 8192,
        handshakeTimeout: 10_000,
      },
      (request, response) => {
        void this.handle(request, response)
      },
    )
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.maxConnections = 32
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.address, resolve)
      })
      this.assertEnabled()
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Listener unavailable.')
      await this.save({ ...this.data, identity, sharing: { ...config, port: address.port } })
      this.server = server
      this.sharingError = null
    } catch (error) {
      server.closeAllConnections()
      server.close()
      throw error
    }
    return this.snapshot()
  }

  invitation(): string {
    this.assertEnabled()
    if (!this.server?.listening || !this.data.identity)
      throw new Error('Start sharing models first.')
    const secret = randomBytes(32).toString('hex')
    this.invitationValue = { secret, expires: Date.now() + 600_000, clientId: null }
    return (
      'copse-machine1-' +
      Buffer.from(
        JSON.stringify({
          version: 1,
          address: this.data.sharing.address,
          port: this.data.sharing.port,
          fingerprint: new X509Certificate(this.data.identity.certificate).fingerprint256,
          secret,
        }),
      ).toString('base64url')
    )
  }
  pair(code: string, viaSshHost?: string): Promise<MachinesState> {
    return this.change(async () => {
      this.assertEnabled()
      if (!this.store.available())
        throw new Error('Unlock secure storage before pairing a machine.')
      const invitation = decodeMachineInvitation(code.trim())
      // A forward reaches only the SSH host's own loopback, so only a machine
      // sharing there can be paired through it.
      if (viaSshHost && invitation.address !== LOOPBACK)
        throw new Error(
          'This invitation shares on a network address. Pair it on that network, or share on "This computer only" and pair over SSH.',
        )
      const result = describeSchema
        .extend({ token: tokenSchema })
        .parse(
          await this.viaRoute(viaSshHost, invitation.port, true, (connectTo) =>
            this.request(
              this.data.id,
              invitation,
              '/pair',
              { secret: invitation.secret, id: this.data.id, name: this.name },
              connectTo ? { connectTo } : {},
            ),
          ),
        )
      if (result.id === this.data.id)
        throw new Error('This invitation belongs to this same Copse profile.')
      const peer = {
        id: result.id,
        name: result.name,
        token: this.store.seal(result.token),
        models: result.models,
        endpoint: {
          address: invitation.address,
          port: invitation.port,
          fingerprint: invitation.fingerprint,
        },
      }
      await this.save({
        ...this.data,
        machines: [...this.data.machines.filter((entry) => entry.id !== peer.id), peer],
      })
      await this.saveRoute(peer.id, viaSshHost)
      this.states.set(peer.id, { status: 'connected', detail: 'Connected' })
      return this.snapshot()
    })
  }
  private async saveRoute(machineId: string, viaSshHost: string | undefined): Promise<void> {
    const routes = new Map(Object.entries(this.store.routes()))
    if (viaSshHost) routes.set(machineId, viaSshHost)
    else routes.delete(machineId)
    // Only machines that are still paired keep a route.
    const paired = new Set(this.data.machines.map((peer) => peer.id))
    await this.store.saveRoutes(Object.fromEntries([...routes].filter(([id]) => paired.has(id))))
  }
  /**
   * Mark every route whose saved SSH host is gone. A new host's id comes from
   * its label, so a host saved later under the same label would otherwise take
   * over the machine's traffic without the user choosing it. The machine stays
   * paired, reads as reached through a removed machine, and is reachable again
   * once it is paired again.
   */
  forgetRemovedSshHosts(): Promise<void> {
    return this.change(async () => {
      const reach = this.reach
      if (!reach) return
      const routes = Object.entries(this.store.routes())
      const gone = (hostId: string | null): boolean =>
        hostId !== null && reach.label(hostId) === null
      if (!routes.some(([, hostId]) => gone(hostId))) return
      await this.store.saveRoutes(
        Object.fromEntries(routes.map(([id, hostId]) => [id, gone(hostId) ? null : hostId])),
      )
    })
  }
  remove(id: string): Promise<MachinesState> {
    return this.change(async () => {
      await this.save({
        ...this.data,
        machines: this.data.machines.filter((peer) => peer.id !== id),
      })
      await this.saveRoute(id, undefined)
      this.states.delete(id)
      for (const [controller, machineId] of this.outgoing) if (machineId === id) controller.abort()
      return this.snapshot()
    })
  }
  revoke(id: string): Promise<MachinesState> {
    return this.change(async () => {
      await this.save({ ...this.data, clients: this.data.clients.filter((peer) => peer.id !== id) })
      this.invitationValue = null
      for (const [controller, clientId] of this.active) if (clientId === id) controller.abort()
      return this.snapshot()
    })
  }
  model(machineId: string, profileId: string): SharedMachineModel {
    this.assertEnabled()
    const model = this.data.machines
      .find((peer) => peer.id === machineId)
      ?.models.find((entry) => entry.id === profileId)
    if (!model)
      throw new Error(
        'Connect the machine and choose one of its shared models in Settings → Machines.',
      )
    return model
  }
  /**
   * Evaluate one of the machine's shared models. Only an `interactive` call (a
   * person pressed Test classifier) may open the route's SSH connection; any
   * other call uses one that is already open.
   */
  async call(
    machineId: string,
    profileId: string,
    request: ClassifierRequest,
    signal: AbortSignal,
    timeoutMs: number,
    { interactive = false }: { interactive?: boolean } = {},
  ): Promise<unknown> {
    this.assertEnabled()
    const peer = this.data.machines.find((entry) => entry.id === machineId)
    if (!peer)
      throw new Error('This machine was removed. Choose another connection in Settings → Machines.')
    try {
      const result = await this.viaRoute(
        this.route(peer.id),
        peer.endpoint.port,
        interactive,
        (connectTo) =>
          this.request(
            peer.id,
            peer.endpoint,
            '/models',
            { method: 'evaluate', profileId, request },
            {
              token: this.store.open(peer.token),
              signal,
              timeoutMs,
              ...(connectTo ? { connectTo } : {}),
            },
          ),
      )
      this.states.set(peer.id, { status: 'connected', detail: 'Connected' })
      return result
    } catch (error) {
      if (!signal.aborted && this.store.enabled() && this.data.machines.includes(peer))
        this.offline(peer.id, error)
      throw error
    }
  }
  private offline(id: string, error: unknown): void {
    this.states.set(id, {
      status:
        error instanceof MachineConnectionError && error.status === 401
          ? 'unavailable'
          : 'reconnecting',
      detail: error instanceof Error ? error.message : 'Machine unavailable.',
    })
  }
  refresh(): Promise<void> {
    if (!this.store.enabled()) return Promise.resolve()
    if (this.refreshing) return this.refreshing
    this.refreshing = this.probe().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }
  private async probe(): Promise<void> {
    await Promise.all(
      this.data.machines.map(async (peer) => {
        try {
          const description = describeSchema.parse(
            await this.viaRoute(this.route(peer.id), peer.endpoint.port, false, (connectTo) =>
              this.request(
                peer.id,
                peer.endpoint,
                '/models',
                { method: 'describe' },
                { token: this.store.open(peer.token), ...(connectTo ? { connectTo } : {}) },
              ),
            ),
          )
          if (description.id !== peer.id)
            throw new MachineConnectionError('Machine identity changed. Pair again.', 401)
          await this.change(async () => {
            if (!this.store.enabled()) return
            if (
              !this.data.machines.some(
                (entry) => entry.id === peer.id && entry.token === peer.token,
              )
            )
              return
            if (
              JSON.stringify(description.models) !== JSON.stringify(peer.models) ||
              description.name !== peer.name
            )
              await this.save({
                ...this.data,
                machines: this.data.machines.map((entry) =>
                  entry.id === peer.id
                    ? { ...entry, name: description.name, models: description.models }
                    : entry,
                ),
              })
            this.states.set(peer.id, { status: 'connected', detail: 'Connected' })
          })
        } catch (error) {
          this.offline(peer.id, error)
        }
      }),
    )
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    const send = (value: object): void => {
      this.assertEnabled()
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    }
    try {
      if (
        !this.store.enabled() ||
        request.method !== 'POST' ||
        request.headers.origin ||
        request.headers['content-type'] !== 'application/json' ||
        request.headers.host !== `${this.data.sharing.address}:${String(this.data.sharing.port)}`
      ) {
        response.writeHead(403).end()
        return
      }
      if (request.url === '/pair') {
        const value = safeJsonParse(await body(request), decodeWithSchema(pairSchema))
        if (!value) {
          response.writeHead(400).end()
          return
        }
        const result = await this.change(async () => {
          this.assertEnabled()
          const invitation = this.invitationValue
          if (
            !invitation ||
            Date.now() > invitation.expires ||
            !matches(value.secret, invitation.secret) ||
            (invitation.clientId && invitation.clientId !== value.id) ||
            value.id === this.data.id
          )
            throw new Error('Invitation unavailable.')
          const previous = this.data.clients.find((entry) => entry.id === value.id)
          const token =
            invitation.clientId === value.id && previous
              ? this.store.open(previous.token)
              : randomBytes(32).toString('hex')
          await this.save({
            ...this.data,
            clients: [
              ...this.data.clients.filter((entry) => entry.id !== value.id),
              { id: value.id, name: value.name, token: this.store.seal(token) },
            ],
          })
          invitation.clientId = value.id
          return { ...this.describe(), token }
        })
        send(result)
        return
      }
      if (request.url !== '/models') {
        response.writeHead(404).end()
        return
      }
      const supplied = request.headers.authorization ?? ''
      const client = this.data.clients.find((entry) =>
        matches(supplied, `Bearer ${this.store.open(entry.token)}`),
      )
      if (!client) {
        response.writeHead(401).end()
        return
      }
      const command = safeJsonParse(await body(request), decodeWithSchema(commandSchema))
      if (!command) {
        response.writeHead(400).end()
        return
      }
      this.assertEnabled()
      if (command.method === 'describe') {
        send(this.describe())
        return
      }
      // Recheck after reading the request: revocation can happen while a peer uploads it.
      if (
        !this.data.clients.some(
          (entry) => entry.id === client.id && entry.token === client.token,
        ) ||
        !this.describe().models.some((model) => model.id === command.profileId)
      ) {
        response.writeHead(403).end()
        return
      }
      if (this.active.size >= 4) {
        response.writeHead(429).end()
        return
      }
      const controller = new AbortController()
      this.active.set(controller, client.id)
      response.once('close', () => {
        controller.abort()
      })
      try {
        const result = await this.evaluate(command.profileId, command.request, controller.signal)
        // An evaluator can settle after cancellation. Recheck the grant at the
        // response boundary so a revoked client never receives that result.
        controller.signal.throwIfAborted()
        if (
          !this.data.clients.some(
            (entry) => entry.id === client.id && entry.token === client.token,
          ) ||
          !this.describe().models.some((model) => model.id === command.profileId)
        ) {
          response.writeHead(403).end()
          return
        }
        send(result)
      } finally {
        this.active.delete(controller)
      }
    } catch {
      if (!response.headersSent) response.writeHead(409)
      response.end('Machine request failed.')
    }
  }
}
