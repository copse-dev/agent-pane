import { createPrivateKey, X509Certificate } from 'node:crypto'
import type { MobileCompanionPublicName } from '../../../shared/types/mobile-companion.ts'
import { NamesApiError, type NamesClient, type NamesDeviceKey } from './names-client.ts'
import { createCertificateRequest, DEVICE_ZONE } from './names-csr.ts'
import { backoffDelay, nextOrderAllowedAt, recentOrders, renewalTime } from './names-renewal.ts'
import type { NamesRecord, NamesStore, StoredCertificate } from './names-store.ts'

type Client = Pick<NamesClient, 'register' | 'setAddress' | 'certificate' | 'status' | 'remove'>
type Registration = NonNullable<NamesRecord['registration']>
type TimerSlot = 'order' | 'address' | 'dns'

/** What the mobile server presents for the trusted name. */
export interface PublicIdentity {
  hostname: string
  key: string
  cert: string
}

export interface RemoteNamesOptions {
  store: NamesStore
  client: (baseUrl: string, key: NamesDeviceKey) => Client
  /** The names API a new registration uses. An existing one keeps the service it registered with. */
  serviceUrl: () => string
  /** IPv4 answers from this Mac's resolver; an unresolvable name returns `[]`. */
  lookup: (hostname: string) => Promise<string[]>
  onChange: () => void
  now?: () => number
  random?: () => number
}

// Timers re-check the wall clock at least hourly: monotonic timers stall while
// the Mac sleeps, and a six-day certificate must not lapse behind one.
const MAX_TIMER_MS = 3_600_000
const DNS_RECHECKS_MS = [15_000, 60_000, 300_000]

/**
 * Phase 1 remote access: this Mac's publicly trusted name. Registration
 * redeems an invite for a label; the Mac then keeps `lan.<label>.u.copse.me`
 * pointed at its LAN address and holds a short-lived `*.<label>.u.copse.me`
 * certificate, renewed well before it lapses. The device key never leaves the
 * Mac; the service only ever sees CSRs and private LAN addresses.
 */
export class RemoteNames {
  private readonly options: RemoteNamesOptions
  private readonly now: () => number
  private readonly random: () => number
  private readonly timers = new Map<TimerSlot, ReturnType<typeof setTimeout>>()
  private record: NamesRecord | null = null
  private key: NamesDeviceKey | null = null
  private certificate: StoredCertificate | null = null
  private renewAt: number | null = null
  private serverAddress: string | null = null
  private remoteState: 'active' | 'dormant' | 'retired' = 'active'
  private dns: MobileCompanionPublicName['dns'] = 'unknown'
  private busy: MobileCompanionPublicName['busy'] = null
  private lastError: string | null = null
  private orderFailures = 0
  private addressFailures = 0
  private dnsAttempt = 0
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(options: RemoteNamesOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  /** Load a saved registration and resume renewal. */
  start(): Promise<void> {
    return this.serial(async () => {
      try {
        this.record = await this.options.store.read()
      } catch (error) {
        this.fail(error)
        this.changed()
        return
      }
      if (!this.record?.registration) return
      this.certificate = await this.options.store.readCertificate(this.record.certificate)
      this.scheduleRenewal()
      this.changed()
      await this.refreshStatus()
    })
  }

  state(): MobileCompanionPublicName {
    const registration = this.record?.registration ?? null
    return {
      serviceUrl: this.record?.api ?? this.options.serviceUrl(),
      state: registration ? this.remoteState : 'unregistered',
      hostname: registration?.lan ?? null,
      certificate: this.certificate
        ? { notAfter: this.certificate.notAfterMs, renewAt: this.renewAt }
        : null,
      dns: registration ? this.dns : 'unknown',
      busy: this.busy,
      lastError: this.lastError,
    }
  }

  /** The certificate to present for the trusted name, while it is valid. */
  identity(): PublicIdentity | null {
    const hostname = this.record?.registration?.lan
    const certificate = this.certificate
    if (!hostname || !certificate || certificate.notAfterMs <= this.now()) return null
    return { hostname, key: certificate.keyPem, cert: certificate.chainPem }
  }

  register(invite: string): Promise<void> {
    return this.serial(async () => {
      if (this.record?.registration) return
      this.busy = 'registering'
      this.lastError = null
      this.changed()
      try {
        const { record, reused } = await this.unregisteredRecord()
        const client = await this.client(record)
        // A saved key whose registration reply never arrived answers for its
        // label; the spent invite would be refused a second time.
        const known = reused ? await this.registeredLabel(client) : null
        const label = known ?? (await this.redeem(client, invite.trim()))
        this.save({ ...record, registration: registrationFor(label), lastAddress: null })
        this.remoteState = 'active'
        this.dns = 'unknown'
      } catch (error) {
        this.fail(error)
        return
      } finally {
        this.busy = null
        this.changed()
      }
      await this.publishAddress()
      await this.checkDns()
      await this.order()
    })
  }

  /** Delete this Mac's records from the service and forget the key and certificate. */
  remove(): Promise<void> {
    return this.serial(async () => {
      const record = this.record
      if (!record) return
      this.busy = 'removing'
      this.lastError = null
      this.changed()
      try {
        if (record.registration) {
          try {
            await (await this.client(record)).remove()
          } catch (error) {
            // Already gone on the service: forgetting locally is the whole job.
            if (!(error instanceof NamesApiError && [401, 403, 404].includes(error.status)))
              throw error
          }
        }
        this.options.store.clear()
        this.reset()
      } catch (error) {
        this.fail(error)
      } finally {
        this.busy = null
        this.changed()
      }
    })
  }

  /** The mobile server bound `address`, or stopped (`null`). */
  setServerAddress(address: string | null): void {
    if (address === this.serverAddress) return
    this.serverAddress = address
    this.dnsAttempt = 0
    void this.serial(async () => {
      await this.publishAddress()
      await this.checkDns()
    })
  }

  recheckDns(): Promise<void> {
    this.dnsAttempt = 0
    return this.serial(() => this.checkDns())
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private async unregisteredRecord(): Promise<{ record: NamesRecord; reused: boolean }> {
    const api = this.options.serviceUrl()
    // Reuse a key that has not registered with this service; it names nothing yet.
    if (this.record && this.record.api === api && !this.record.registration)
      return { record: this.record, reused: true }
    const { key, sealedKey } = await this.options.store.createKey()
    this.key = key
    const record: NamesRecord = {
      v: 1,
      api,
      sealedKey,
      registration: null,
      lastAddress: null,
      orders: [],
      certificate: null,
    }
    this.save(record)
    return { record, reused: false }
  }

  private async registeredLabel(client: Client): Promise<string | null> {
    try {
      return (await client.status()).label
    } catch {
      return null
    }
  }

  private async redeem(client: Client, invite: string): Promise<string> {
    const response = await client.register(invite)
    // Serve only the name this Mac derives itself, never one a reply supplies.
    if (response.hostnames.lan !== registrationFor(response.label).lan)
      throw new Error('The Copse names service returned an unexpected hostname.')
    return response.label
  }

  private async client(record: NamesRecord): Promise<Client> {
    this.key ??= await this.options.store.openKey(record.sealedKey)
    return this.options.client(record.api, this.key)
  }

  private async refreshStatus(): Promise<void> {
    const record = this.record
    if (!record?.registration) return
    try {
      const status = await (await this.client(record)).status()
      this.remoteState = status.state
      // Mirror the service, so an address it lost or refused is sent again.
      if (status.lanAddress !== record.lastAddress)
        this.save({ ...record, lastAddress: status.lanAddress })
    } catch (error) {
      this.fail(error)
    }
    this.changed()
    await this.publishAddress()
  }

  private async publishAddress(): Promise<void> {
    const record = this.record
    const address = this.serverAddress
    if (!record?.registration || !address || record.lastAddress === address || this.stopped) return
    this.disarm('address')
    try {
      await (await this.client(record)).setAddress(address)
      this.save({ ...record, lastAddress: address })
      this.addressFailures = 0
      this.dnsAttempt = 0
    } catch (error) {
      this.fail(error)
      this.addressFailures += 1
      const retryAfter = error instanceof NamesApiError ? error.retryAfterSeconds : null
      this.arm('address', this.now() + backoffDelay(this.addressFailures, retryAfter), () =>
        this.publishAddress(),
      )
    }
    this.changed()
  }

  private async order(): Promise<void> {
    const record = this.record
    const registration = record?.registration
    if (!record || !registration || this.stopped) return
    const now = this.now()
    const allowedAt = nextOrderAllowedAt(record.orders, now)
    if (allowedAt > now) {
      this.scheduleAt(allowedAt)
      return
    }
    // Count the order before sending it: a reply lost in transit still used one.
    const counted = { ...record, orders: [...recentOrders(record.orders, now), now] }
    this.save(counted)
    try {
      const request = createCertificateRequest(registration.label)
      const issued = await (await this.client(counted)).certificate(request.csr)
      const meta = verifiedCertificate(issued, request.privateKeyPem, registration, this.now())
      this.options.store.writeCertificate(issued.chain, request.privateKeyPem)
      this.save({ ...counted, certificate: meta })
      this.certificate = { ...meta, chainPem: issued.chain, keyPem: request.privateKeyPem }
      this.remoteState = 'active'
      this.orderFailures = 0
      this.lastError = null
      this.scheduleRenewal()
    } catch (error) {
      this.fail(error)
      this.orderFailures += 1
      const retryAfter = error instanceof NamesApiError ? error.retryAfterSeconds : null
      this.scheduleAt(this.now() + backoffDelay(this.orderFailures, retryAfter))
    }
    this.changed()
  }

  private scheduleRenewal(): void {
    const certificate = this.certificate
    this.scheduleAt(
      certificate && certificate.notAfterMs > this.now()
        ? renewalTime(certificate, this.now(), this.random)
        : this.now(),
    )
  }

  private scheduleAt(at: number): void {
    this.renewAt = at
    this.arm('order', at, () => this.order())
  }

  private async checkDns(): Promise<void> {
    this.disarm('dns')
    const hostname = this.record?.registration?.lan
    const address = this.serverAddress
    if (!hostname || !address) {
      this.dns = 'unknown'
      this.changed()
      return
    }
    this.dns = 'checking'
    this.changed()
    let answers: string[]
    try {
      answers = await this.options.lookup(hostname)
    } catch {
      answers = []
    }
    this.dns = answers.includes(address) ? 'ok' : answers.length === 0 ? 'unresolved' : 'mismatch'
    // A just-published record can take a minute to reach the resolver.
    const delay = DNS_RECHECKS_MS[this.dnsAttempt]
    if (this.dns !== 'ok' && delay !== undefined) {
      this.dnsAttempt += 1
      this.arm('dns', this.now() + delay, () => this.checkDns())
    }
    this.changed()
  }

  /** Run `work` (serialised) at wall-clock time `at`, re-checking at least hourly. */
  private arm(slot: TimerSlot, at: number, work: () => Promise<void>): void {
    this.disarm(slot)
    if (this.stopped) return
    const timer = setTimeout(
      () => {
        this.timers.delete(slot)
        if (this.stopped) return
        if (this.now() < at) this.arm(slot, at, work)
        else void this.serial(work)
      },
      Math.max(0, Math.min(at - this.now(), MAX_TIMER_MS)),
    )
    timer.unref()
    this.timers.set(slot, timer)
  }

  private disarm(slot: TimerSlot): void {
    const timer = this.timers.get(slot)
    if (timer) clearTimeout(timer)
    this.timers.delete(slot)
  }

  private save(record: NamesRecord): void {
    this.options.store.write(record)
    this.record = record
  }

  private reset(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.record = null
    this.key = null
    this.certificate = null
    this.renewAt = null
    this.remoteState = 'active'
    this.dns = 'unknown'
    this.orderFailures = 0
    this.addressFailures = 0
  }

  private fail(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error)
    console.error('[remote-names]', this.lastError)
  }

  private changed(): void {
    this.options.onChange()
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }
}

function registrationFor(label: string): Registration {
  return { label, lan: `lan.${label}.${DEVICE_ZONE}`, web: `web.${label}.${DEVICE_ZONE}` }
}

/** Accept only a chain for this label's wildcard, over the key this Mac just made, still valid. */
function verifiedCertificate(
  issued: { chain: string; renewalWindow: { start: string; end: string } | null },
  privateKeyPem: string,
  registration: Registration,
  nowMs: number,
): NonNullable<NamesRecord['certificate']> {
  const leaf = new X509Certificate(issued.chain)
  const notBeforeMs = Date.parse(leaf.validFrom)
  const notAfterMs = Date.parse(leaf.validTo)
  if (
    !leaf.checkPrivateKey(createPrivateKey(privateKeyPem)) ||
    leaf.checkHost(registration.lan) === undefined ||
    !(notAfterMs > nowMs) ||
    !Number.isFinite(notBeforeMs)
  )
    throw new Error('The Copse names service returned a certificate this Mac cannot use.')
  const startMs = Date.parse(issued.renewalWindow?.start ?? '')
  const endMs = Date.parse(issued.renewalWindow?.end ?? '')
  return {
    notBeforeMs,
    notAfterMs,
    renewalWindow: Number.isFinite(startMs) && Number.isFinite(endMs) ? { startMs, endMs } : null,
  }
}
