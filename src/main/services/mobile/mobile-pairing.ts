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

  request(label: string, code: string): Promise<MobileCompanionAccess | null> {
    this.pending?.resolve(null)
    return new Promise((resolve) => {
      this.pending = { pairing: { id: randomUUID(), label, code }, resolve }
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
