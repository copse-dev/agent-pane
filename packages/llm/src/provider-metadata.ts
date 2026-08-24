// The provider catalog: the built-in OpenAI-compatible presets and the
// per-provider data-retention policies, loaded from
// `packages/llm/data/provider-metadata.json`.
//
// The JSON file is the single source of truth — there is no generated mirror of
// it. This module is the contract: a zod schema that both types the catalog and
// rejects a malformed one at load, so adding a provider stays a data edit while
// the compiler still knows `zdr` is a six-way union rather than `string`.
//
// Descriptive facts belong in the JSON. Anything derived or security-relevant
// stays in code, on purpose:
//   - `local` / `prefix` / `builtin` are computed in extra-providers.ts —
//     `local` from the base URL, so no catalog edit can mark a remote endpoint
//     local and skip the "data leaves this machine" treatment in Settings.
//   - The wire dialect behind `apiStyle` lives in create-provider.ts.
//   - The provider-host allowlist lives in provider-host-policy.ts.
// That split is what would let this catalog move to a shared registry later
// without the security decisions travelling with it.
//
// See docs/provider-data-policies.md.

import { z } from 'zod'
import catalog from '../data/provider-metadata.json'

const presetModelSchema = z
  .object({
    /** Upstream model id sent to the provider. */
    id: z.string().min(1),
    /** Context window in tokens; falls back to the provider default. */
    contextWindow: z.int().positive().optional(),
    inputPricePerMTok: z.number().nonnegative().optional(),
    outputPricePerMTok: z.number().nonnegative().optional(),
    /** Rationale for the entry. Prose for the next reader; never shipped. */
    comment: z.string().optional(),
  })
  .strict()

const presetSchema = z
  .object({
    /** Stable slug: model-selection prefix source and API-key lookup id. */
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Human label / picker optgroup heading. */
    label: z.string().min(1),
    /** OpenAI-compatible base URL the SDK talks to. */
    baseUrl: z.url(),
    /** Wire protocol. Absent means Chat Completions. */
    apiStyle: z.enum(['chat-completions', 'responses']).optional(),
    /** Env var that can also supply the key. */
    envVar: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    keyLabel: z.string().min(1),
    keyPlaceholder: z.string().min(1),
    keyHint: z.string().min(1),
    /** Key-format prefix, checked before any network call. */
    keyPrefix: z.string().min(1).optional(),
    fallbackContextWindow: z.int().positive(),
    /** OpenAI `stream_options.include_usage`. */
    includeUsage: z.boolean().optional(),
    /** Extra fields merged into every request body. */
    extraBody: z.record(z.string(), z.unknown()).optional(),
    /** Curated shortlist for the picker; may be empty (bring-your-own id). */
    models: z.array(presetModelSchema),
    comment: z.string().optional(),
  })
  .strict()

const dataPolicySchema = z
  .object({
    /** Provider slugs this policy applies to; empty means host-only. */
    slugs: z.array(z.string().min(1)),
    /** API hostnames that resolve to this policy for custom endpoints. */
    hosts: z.array(z.string().min(1)).optional(),
    retainsPrompts: z.union([z.boolean(), z.null()]),
    retentionDays: z.int().positive().optional(),
    trainsOnData: z.union([z.boolean(), z.null()]),
    zdr: z.enum(['default', 'request', 'setting', 'contract', 'none', 'unknown']),
    note: z.string().min(1),
    policyUrl: z.url().startsWith('https://'),
    comment: z.string().optional(),
  })
  .strict()

const catalogSchema = z
  .object({
    /** Allowed so the data file can point an editor at a schema, if one is published. */
    $schema: z.string().optional(),
    /** When the data policies were last checked against the linked sources. */
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    presets: z.array(presetSchema).min(1),
    dataPolicies: z.array(dataPolicySchema).min(1),
  })
  .strict()

/** A model in a preset's curated shortlist. */
export interface ProviderPresetModel {
  id: string
  contextWindow?: number
  inputPricePerMTok?: number
  outputPricePerMTok?: number
}

/** A shipped OpenAI-compatible provider preset, minus its derived fields. */
export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  apiStyle?: 'chat-completions' | 'responses'
  envVar?: string
  keyLabel: string
  keyPlaceholder: string
  keyHint: string
  keyPrefix?: string
  fallbackContextWindow: number
  includeUsage?: boolean
  extraBody?: Record<string, unknown>
  models: readonly ProviderPresetModel[]
}

/** A data-retention policy plus the slugs and API hosts it resolves for. */
export interface ProviderDataPolicyEntry {
  slugs: readonly string[]
  hosts?: readonly string[]
  retainsPrompts: boolean | null
  retentionDays?: number
  trainsOnData: boolean | null
  zdr: 'default' | 'request' | 'setting' | 'contract' | 'none' | 'unknown'
  note: string
  policyUrl: string
}

// zod models an absent key as `T | undefined`, which `exactOptionalPropertyTypes`
// rejects against a plain `?: T`. These three functions are that bridge, and the
// only reason the shapes above are written out rather than inferred: they copy
// the validated catalog into the exact-optional form the rest of the app uses,
// dropping `comment` (prose for whoever edits the catalog, never data).
function toModel(model: z.infer<typeof presetModelSchema>): ProviderPresetModel {
  return {
    id: model.id,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.inputPricePerMTok !== undefined
      ? { inputPricePerMTok: model.inputPricePerMTok }
      : {}),
    ...(model.outputPricePerMTok !== undefined
      ? { outputPricePerMTok: model.outputPricePerMTok }
      : {}),
  }
}

function toPreset(preset: z.infer<typeof presetSchema>): ProviderPreset {
  return {
    id: preset.id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    ...(preset.apiStyle !== undefined ? { apiStyle: preset.apiStyle } : {}),
    ...(preset.envVar !== undefined ? { envVar: preset.envVar } : {}),
    keyLabel: preset.keyLabel,
    keyPlaceholder: preset.keyPlaceholder,
    keyHint: preset.keyHint,
    ...(preset.keyPrefix !== undefined ? { keyPrefix: preset.keyPrefix } : {}),
    fallbackContextWindow: preset.fallbackContextWindow,
    ...(preset.includeUsage !== undefined ? { includeUsage: preset.includeUsage } : {}),
    ...(preset.extraBody !== undefined ? { extraBody: preset.extraBody } : {}),
    models: preset.models.map(toModel),
  }
}

function toDataPolicy(entry: z.infer<typeof dataPolicySchema>): ProviderDataPolicyEntry {
  return {
    slugs: entry.slugs,
    ...(entry.hosts !== undefined ? { hosts: entry.hosts } : {}),
    retainsPrompts: entry.retainsPrompts,
    ...(entry.retentionDays !== undefined ? { retentionDays: entry.retentionDays } : {}),
    trainsOnData: entry.trainsOnData,
    zdr: entry.zdr,
    note: entry.note,
    policyUrl: entry.policyUrl,
  }
}

const parsed = catalogSchema.safeParse(catalog)
if (!parsed.success) {
  // The catalog is compiled in, so this can only fire on a bad edit — and
  // provider-metadata.test.ts fails first. Throw rather than degrade: a
  // half-loaded catalog would silently drop providers or privacy badges.
  throw new Error(`provider-metadata.json is invalid:\n${z.prettifyError(parsed.error)}`)
}

/** The presets in catalog order, which is picker and local-chip order. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = parsed.data.presets.map(toPreset)
export const PROVIDER_DATA_POLICIES: readonly ProviderDataPolicyEntry[] =
  parsed.data.dataPolicies.map(toDataPolicy)
export const PROVIDER_METADATA_LAST_VERIFIED = parsed.data.lastVerified
