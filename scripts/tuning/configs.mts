/**
 * A tuning config is a validated Harbor tuning (`harbor-tuning.mts`) plus an id. Its
 * identity is the content hash of the canonical tuning, so two ids that name the same
 * tuning are the same configuration, and a ledger line can always be traced back to
 * exactly what was measured.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  decodeHarborTuning,
  harborTuningSchema,
  type HarborTuning,
} from '../../src/main/services/container-runtime/harbor-tuning.mts'

export interface ResolvedConfig {
  id: string
  /** sha256 hex of the canonical tuning JSON. */
  hash: string
  tuning: HarborTuning
}

/** JSON with object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function configHash(tuning: HarborTuning): string {
  return createHash('sha256').update(canonicalJson(tuning)).digest('hex')
}

/** Validate a tuning (strict schema) and name it. Throws on an invalid tuning. */
export function makeConfig(id: string, tuning: unknown): ResolvedConfig {
  const decoded = decodeHarborTuning(JSON.stringify(tuning))
  if (decoded === null) {
    throw new Error(
      `Config ${id}: not a valid Harbor tuning (unknown keys and bad values are rejected)`,
    )
  }
  return { id, hash: configHash(decoded), tuning: decoded }
}

/** The id an unnamed config gets, from its hash. */
export function inlineConfigId(hash: string): string {
  return `cfg-${hash.slice(0, 8)}`
}

const registryEntrySchema = z.strictObject({
  id: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  tuning: harborTuningSchema,
})

/**
 * Configs that have been run, by id, so `--config <id>` works in a later invocation.
 * An id is bound to one hash forever: reusing it for different content is an error,
 * because it would make two different measurements look like one.
 */
export class ConfigRegistry {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  private path(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid config id '${id}'`)
    return join(this.directory, `${id}.json`)
  }

  load(id: string): ResolvedConfig | null {
    const path = this.path(id)
    if (!existsSync(path)) return null
    const entry = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(registryEntrySchema))
    if (entry === null) throw new Error(`${path} is not a valid config record`)
    const config = makeConfig(entry.id, entry.tuning)
    if (config.hash !== entry.hash) throw new Error(`${path} does not match its recorded hash`)
    return config
  }

  register(config: ResolvedConfig): void {
    const existing = this.load(config.id)
    if (existing !== null) {
      if (existing.hash !== config.hash) {
        throw new Error(
          `Config id '${config.id}' is already registered with different content; choose another id`,
        )
      }
      return
    }
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(
      this.path(config.id),
      `${JSON.stringify({ id: config.id, hash: config.hash, tuning: config.tuning }, null, 2)}\n`,
    )
  }
}

/**
 * Resolve a `--config` argument: `default` (the supplied default config), an inline
 * JSON tuning, or the id of a registered config.
 */
export function resolveConfigArgument(
  argument: string,
  context: { defaultConfig: ResolvedConfig; registry: ConfigRegistry },
): ResolvedConfig {
  const text = argument.trim()
  if (text === 'default') return context.defaultConfig
  if (text.startsWith('{')) {
    const parsed = safeJsonParse(text)
    if (parsed === null) throw new Error('--config looks like JSON but does not parse')
    const probe = makeConfig('probe', parsed)
    return { ...probe, id: inlineConfigId(probe.hash) }
  }
  const registered = context.registry.load(text)
  if (registered === null) {
    throw new Error(`Unknown config '${text}': not 'default', inline JSON, or a registered id`)
  }
  return registered
}
