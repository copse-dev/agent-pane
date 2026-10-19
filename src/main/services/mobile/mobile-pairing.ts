import { randomUUID } from 'node:crypto'
import type {
  MobileCompanionAccess,
  MobileCompanionPairing,
} from '../../../shared/types/mobile-companion.ts'

/** Display codes are not identities: replacements may reuse both code and label. */
export class MobilePairing {
  private pending: {
    pairing: MobileCompanionPairing
    resolve: (access: MobileCompanionAccess | null) => void
  } | null = null

  current(): MobileCompanionPairing | null {
    return this.pending ? { ...this.pending.pairing } : null
  }

  request(label: string, code: string, signal: AbortSignal): Promise<MobileCompanionAccess | null> {
    this.pending?.resolve(null)
    this.pending = null
    if (signal.aborted) return Promise.resolve(null)
    const id = randomUUID()
    const cancel = (): void => {
      if (this.pending?.pairing.id !== id) return
      const pending = this.pending
      this.pending = null
      pending.resolve(null)
    }
    signal.addEventListener('abort', cancel, { once: true })
    return new Promise<MobileCompanionAccess | null>((resolve) => {
      this.pending = { pairing: { id, label, code }, resolve }
    }).finally(() => {
      signal.removeEventListener('abort', cancel)
    })
  }

  respond(decision: MobileCompanionAccess | 'deny', code: string, id: string): boolean {
    const pending = this.pending
    if (!pending || pending.pairing.id !== id || pending.pairing.code !== code) return false
    this.pending = null
    pending.resolve(decision === 'deny' ? null : decision)
    return true
  }
}
