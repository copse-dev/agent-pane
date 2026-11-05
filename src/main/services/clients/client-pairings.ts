import { randomInt, randomUUID } from 'node:crypto'
import type { ClientAccess } from '../../../shared/client-auth.ts'

/** What the transport knows about how a pairing request arrived. */
export interface PairingContext {
  /** The client reached this host over a publicly trusted name its browser verified. */
  trustedName?: boolean
}

interface Pairing {
  binding: string | undefined
  context: PairingContext
  controller: AbortController
  expires: number
  timeout: ReturnType<typeof setTimeout>
  result: { state: 'pending' } | { state: 'denied' } | { state: 'approved'; token: string }
  issuedId?: string
}

interface PairingOptions {
  maxPending: number
  issue: (
    label: string,
    access: ClientAccess,
    binding: string | undefined,
  ) => { id: string; token: string }
  revoke: (id: string) => void
  canIssue?: () => boolean
  approve: (
    label: string,
    code: string,
    signal: AbortSignal,
    context?: PairingContext,
  ) => Promise<ClientAccess | null>
}

/** Desktop consent, bounded pending work, expiry and one-time token delivery for all clients. */
export class ClientPairings {
  private readonly pending = new Map<string, Pairing>()
  private lastRequest = -Infinity
  private closed = false
  private readonly options: PairingOptions

  constructor(options: PairingOptions) {
    this.options = options
  }

  request(
    label: string,
    binding?: string,
    context: PairingContext = {},
  ): { id: string; code: string } | null {
    this.expire()
    if (
      this.closed ||
      this.pending.size >= this.options.maxPending ||
      Date.now() - this.lastRequest < 1000 ||
      this.options.canIssue?.() === false
    )
      return null
    this.lastRequest = Date.now()
    const id = randomUUID()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const timeout = setTimeout(() => {
      this.remove(id)
    }, 120_000)
    timeout.unref()
    const pairing: Pairing = {
      binding,
      context,
      controller: new AbortController(),
      expires: Date.now() + 120_000,
      timeout,
      result: { state: 'pending' },
    }
    this.pending.set(id, pairing)
    void this.approve(id, pairing, label, code)
    return { id, code }
  }

  poll(id: string, binding?: string): Pairing['result'] | null {
    this.expire()
    const pairing = this.pending.get(id)
    if (!pairing || pairing.binding !== binding) return null
    const result = pairing.result
    if (result.state !== 'pending') this.remove(id, true)
    return { ...result }
  }

  close(): void {
    this.closed = true
    for (const id of this.pending.keys()) this.remove(id)
  }

  private expire(): void {
    for (const [id, pairing] of this.pending) if (pairing.expires <= Date.now()) this.remove(id)
  }

  private remove(id: string, delivered = false): void {
    const pairing = this.pending.get(id)
    if (!pairing) return
    this.pending.delete(id)
    clearTimeout(pairing.timeout)
    pairing.controller.abort()
    // An approved credential nobody collected must not survive an expired pairing.
    if (!delivered && pairing.issuedId) {
      try {
        // Credential stores restrict in-memory authority before persisting revocation.
        this.options.revoke(pairing.issuedId)
      } catch (error) {
        console.error('[client-auth] Could not persist uncollected credential revocation:', error)
      }
    }
  }

  private async approve(id: string, pairing: Pairing, label: string, code: string): Promise<void> {
    try {
      const access = await this.options.approve(
        label,
        code,
        pairing.controller.signal,
        pairing.context,
      )
      this.expire()
      if (this.closed || this.pending.get(id) !== pairing) return
      if (access === null || this.options.canIssue?.() === false) {
        pairing.result = { state: 'denied' }
        return
      }
      const issued = this.options.issue(label, access, pairing.binding)
      pairing.issuedId = issued.id
      pairing.result = { state: 'approved', token: issued.token }
    } catch {
      pairing.result = { state: 'denied' }
    }
  }
}
