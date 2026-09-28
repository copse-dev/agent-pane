import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'

const preferenceSchema = z.object({
  enabled: z.boolean(),
  address: z
    .string()
    .regex(/^(?:\d{1,3}\.){3}\d{1,3}$/)
    .optional(),
})
type Preference = z.infer<typeof preferenceSchema>

/** The user's durable on/off choice, separate from settings and device tokens. */
export class MobilePreference {
  private readonly path: string
  private value: Preference

  constructor(directory = join(copseDataRoot(), 'lan')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'service.json')
    try {
      const parsed = safeJsonParse(
        readFileSync(this.path, 'utf8'),
        decodeWithSchema(preferenceSchema),
      )
      if (!parsed) throw new Error('Invalid Copse Mobile Companion preference')
      this.value = parsed
      chmodSync(this.path, 0o600)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.value = { enabled: false }
      } else throw error
    }
  }

  current(): Preference {
    return this.value
  }

  enable(address: string): void {
    this.value = { enabled: true, address }
    this.save()
  }

  disable(): void {
    this.value = { ...this.value, enabled: false }
    this.save()
  }

  private save(): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}
