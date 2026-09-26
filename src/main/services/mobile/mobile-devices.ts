import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import type { MobilePrincipal } from './mobile-decisions.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'

const deviceSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1).max(64),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(),
  access: z.enum(['read', 'control']).default('read'),
})
type Device = z.infer<typeof deviceSchema>

export class MobileDevices {
  private readonly path: string
  private devices: Device[]

  constructor(directory = join(copseDataRoot(), 'lan')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'devices.json')
    try {
      const parsed = safeJsonParse(
        readFileSync(this.path, 'utf8'),
        decodeWithSchema(z.array(deviceSchema)),
      )
      if (parsed === null) throw new Error('Invalid Copse LAN device store')
      this.devices = parsed
      chmodSync(this.path, 0o600)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') this.devices = []
      else throw error
    }
  }

  list(): Array<MobilePrincipal & { createdAt: number; access: 'read' | 'control' }> {
    return this.devices.map(({ id, label, createdAt, access }) => ({
      id,
      label,
      createdAt,
      access,
    }))
  }

  issue(label: string, access: 'read' | 'control' = 'read'): { id: string; token: string } {
    const token = randomBytes(32).toString('hex')
    const id = randomUUID()
    this.devices.push({
      id,
      label,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      createdAt: Date.now(),
      access,
    })
    this.save()
    return { id, token }
  }

  authenticate(header: string | undefined): boolean {
    return this.principal(header) !== null
  }

  principal(header: string | undefined): (MobilePrincipal & { access: 'read' | 'control' }) | null {
    if (!header?.startsWith('Bearer ')) return null
    const token = header.slice(7)
    if (!/^[0-9a-f]{64}$/.test(token)) return null
    const candidate = createHash('sha256').update(token).digest()
    const device = this.devices.find((device) =>
      timingSafeEqual(candidate, Buffer.from(device.tokenHash, 'hex')),
    )
    return device ? { id: device.id, label: device.label, access: device.access } : null
  }

  setAccess(id: string, access: 'read' | 'control'): void {
    const device = this.devices.find((item) => item.id === id)
    if (!device) return
    device.access = access
    this.save()
  }

  revoke(id: string): void {
    this.devices = this.devices.filter((device) => device.id !== id)
    this.save()
  }

  private save(): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.devices, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}
