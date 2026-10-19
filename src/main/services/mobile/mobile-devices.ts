import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  ClientCredentials,
  clientCredentialSchema,
  type ClientCredential,
  type ClientPrincipal,
} from '../clients/client-credentials.ts'
import type { ClientAccess } from '../../../shared/client-auth.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'

export class MobileDevices {
  private readonly path: string
  private readonly credentials: ClientCredentials

  constructor(directory = join(copseDataRoot(), 'lan')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'devices.json')
    let records: ClientCredential[]
    try {
      const parsed = safeJsonParse(
        readFileSync(this.path, 'utf8'),
        decodeWithSchema(z.array(clientCredentialSchema.omit({ binding: true }))),
      )
      if (parsed === null) throw new Error('Invalid Copse LAN device store')
      records = parsed
      chmodSync(this.path, 0o600)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') records = []
      else throw error
    }
    this.credentials = new ClientCredentials(records, (devices) => {
      this.save(devices)
    })
  }

  list(): Array<ClientPrincipal & { createdAt: number }> {
    return this.credentials.list()
  }

  issue(label: string, access: ClientAccess = 'read'): { id: string; token: string } {
    return this.credentials.issue(label, access)
  }

  authenticate(header: string | undefined): boolean {
    return this.principal(header) !== null
  }

  principal(
    header: string | undefined,
    requiredAccess: ClientAccess = 'read',
  ): ClientPrincipal | null {
    return this.credentials.principal(header, undefined, requiredAccess)
  }

  setAccess(id: string, access: ClientAccess): void {
    this.credentials.setAccess(id, access)
  }

  revoke(id: string): void {
    this.credentials.revoke(id)
  }

  private save(devices: ClientCredential[]): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(devices, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}
