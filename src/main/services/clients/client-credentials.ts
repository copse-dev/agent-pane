import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { clientAccessSchema, type ClientAccess } from '../../../shared/client-auth.ts'

export const clientCredentialSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1).max(64),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(),
  access: clientAccessSchema.default('read'),
  binding: z.string().optional(),
})
export type ClientCredential = z.infer<typeof clientCredentialSchema>
export type ClientPrincipal = Pick<ClientCredential, 'id' | 'label' | 'access'>

/** Shared bearer authority. Each transport owns its store and credential lifetime. */
export class ClientCredentials {
  private records: ClientCredential[]
  private readonly persist: (records: ClientCredential[]) => void

  constructor(
    records: ClientCredential[] = [],
    persist: (records: ClientCredential[]) => void = () => {},
  ) {
    this.records = records.map((record) => ({ ...record }))
    this.persist = persist
  }

  list(): Array<ClientPrincipal & { createdAt: number }> {
    return this.records.map(({ id, label, access, createdAt }) => ({
      id,
      label,
      access,
      createdAt,
    }))
  }

  issue(
    label: string,
    access: ClientAccess = 'read',
    binding?: string,
  ): { id: string; token: string } {
    const token = randomBytes(32).toString('hex')
    const id = randomUUID()
    this.update([
      ...this.records,
      {
        id,
        label,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        createdAt: Date.now(),
        access,
        ...(binding === undefined ? {} : { binding }),
      },
    ])
    return { id, token }
  }

  principal(
    header: string | undefined,
    binding?: string,
    requiredAccess: ClientAccess = 'read',
  ): ClientPrincipal | null {
    if (!header?.startsWith('Bearer ')) return null
    const token = header.slice(7)
    if (!/^[0-9a-f]{64}$/.test(token)) return null
    const candidate = createHash('sha256').update(token).digest()
    const record = this.records.find((item) =>
      timingSafeEqual(candidate, Buffer.from(item.tokenHash, 'hex')),
    )
    if (
      !record ||
      record.binding !== binding ||
      (requiredAccess === 'control' && record.access !== 'control')
    )
      return null
    return { id: record.id, label: record.label, access: record.access }
  }

  setAccess(id: string, access: ClientAccess): void {
    if (!this.records.some((record) => record.id === id)) return
    this.update(
      this.records.map((record) => (record.id === id ? { ...record, access } : record)),
      access === 'read',
    )
  }

  revoke(id: string): void {
    this.update(
      this.records.filter((record) => record.id !== id),
      true,
    )
  }

  clear(): void {
    this.update([], true)
  }

  private update(records: ClientCredential[], reduceAuthority = false): void {
    // Restrictions take effect even if persistence fails; new authority takes effect
    // only after a successful durable write. The caller still receives the write error.
    if (reduceAuthority) this.records = records
    this.persist(records.map((record) => ({ ...record })))
    this.records = records
  }
}
