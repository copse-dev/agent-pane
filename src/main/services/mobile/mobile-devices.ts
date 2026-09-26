import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'

const deviceSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1).max(64),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(),
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

  list(): Array<{ id: string; label: string; createdAt: number }> {
    return this.devices.map(({ id, label, createdAt }) => ({
      id,
      label,
      createdAt,
    }))
  }

  issue(label: string): { id: string; token: string } {
    const token = randomBytes(32).toString('hex')
    const id = randomUUID()
    this.devices.push({
      id,
      label,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      createdAt: Date.now(),
    })
    this.save()
    return { id, token }
  }

  authenticate(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false
    const token = header.slice(7)
    if (!/^[0-9a-f]{64}$/.test(token)) return false
    const candidate = createHash('sha256').update(token).digest()
    return this.devices.some((device) =>
      timingSafeEqual(candidate, Buffer.from(device.tokenHash, 'hex')),
    )
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
