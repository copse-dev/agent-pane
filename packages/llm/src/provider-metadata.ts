// The provider catalog: the built-in OpenAI-compatible presets and the
// per-provider data-retention policies, loaded from
// `packages/llm/data/provider-metadata.json`.
//
// The JSON file is the single source of truth — there is no generated mirror of
// it. This module is the contract: zod schemas that both type the catalog
// (every exported type is schema-derived per docs/type-safety.md) and reject a
// malformed catalog at load, so adding a provider stays a data edit while the
// compiler still knows `zdr` is a six-way union rather than `string`.
//
// SECURITY: the catalog is part of the credential-egress trust base. Preset
// base URLs feed `builtinProviderHosts()` (provider-host-policy.ts), the set of
// hosts API keys may reach WITHOUT a user approval prompt. That is why
// `baseUrl` is refined through `isSafeCredentialBaseUrl` at load — the same
// floor user-added customs get — and why this file must stay compiled into the
// bundle and code-reviewed: a fetched or remotely-synced catalog must never
// reach BUILTIN_EXTRA_PROVIDERS without revisiting that gate.
//
// Beyond the URL floor, what stays in code: `local`/`prefix`/`builtin` are
// derived in extra-providers.ts (`local` from the base URL, so no catalog edit
// can mark a remote endpoint local); the wire dialect behind `apiStyle` lives
// in create-provider.ts; the OpenRouter policy variants live in
// data-policies.ts. See docs/provider-data-policies.md.

import { z } from 'zod'
import { isSafeCredentialBaseUrl } from './credential-url.ts'
import catalog from '../data/provider-metadata.json' with { type: 'json' }

/** Reserved-slug shape shared by preset ids and policy slugs. */
const slug = z.string().regex(/^[a-z][a-z0-9-]*$/)

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
    id: slug,
    /** Human label / picker optgroup heading. */
    label: z.string().min(1),
    /**
     * OpenAI-compatible base URL the SDK talks to. Held to the same floor as
     * user-added customs (`isSafeCredentialBaseUrl`): https only — no embedded
     * credentials, no private/link-local hosts — except http to loopback for
     * the local-server presets. Enforced here, not in a test, because a preset
     * host is credential-egress-allowlisted without a prompt.
     */
    baseUrl: z.url().refine(isSafeCredentialBaseUrl, 'unsafe credential base URL'),
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
    /**
     * Context window used when a selected model has no known size of its own.
     * Absent means DEFAULT_EXTRA_PROVIDER_CONTEXT (applied in
     * extra-providers.ts, so the catalog and user customs share one default).
     */
    fallbackContextWindow: z.int().positive().optional(),
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
    /** Provider slugs this policy applies to; empty only for host-only entries. */
    slugs: z.array(slug),
    /** API hostnames (lowercase) that resolve to this policy for custom endpoints. */
    hosts: z.array(z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/)).optional(),
    /**
     * Prompts/completions are retained at rest by default. `null` = unknown or
     * depends on a third party (e.g. Hugging Face's routed partners).
     */
    retainsPrompts: z.union([z.boolean(), z.null()]),
    /** Stated retention window in days, when the provider publishes one. */
    retentionDays: z.int().positive().optional(),
    /**
     * Inputs/outputs may be used to train or improve models by default.
     * `null` = unknown / partner-dependent.
     */
    trainsOnData: z.union([z.boolean(), z.null()]),
    /**
     * How zero-data-retention can be achieved with this provider:
     * - `default`   — ZDR is the provider's default behavior
     * - `request`   — a per-request parameter or self-serve program enables it
     * - `setting`   — an account/console toggle enables it
     * - `contract`  — only via a sales/enterprise arrangement
     * - `none`      — no documented ZDR path
     * - `unknown`   — not determinable (e.g. depends on a routed partner)
     */
    zdr: z.enum(['default', 'request', 'setting', 'contract', 'none', 'unknown']),
    /** One-line summary shown as a Settings hint. */
    note: z.string().min(1),
    /** Primary source (provider's own docs/policy). */
    policyUrl: z.url().startsWith('https://'),
    comment: z.string().optional(),
  })
  .strict()
  // An entry reachable by neither slug nor host would validate, load, and then
  // resolve for nothing — Settings would show "Data policy unknown" for a
  // provider whose policy sits right here in the file.
  .refine(
    (entry) => entry.slugs.length > 0 || (entry.hosts?.length ?? 0) > 0,
    'policy entry has neither slugs nor hosts and can never be resolved',
  )

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
export type ProviderPresetModel = Omit<z.infer<typeof presetModelSchema>, 'comment'>

/** A shipped OpenAI-compatible provider preset, minus its derived fields. */
export type ProviderPreset = Omit<z.infer<typeof presetSchema>, 'comment' | 'models'> & {
  models: readonly ProviderPresetModel[]
}

/** A data-retention policy plus the slugs and API hosts it resolves for. */
export type ProviderDataPolicyEntry = Omit<z.infer<typeof dataPolicySchema>, 'comment'>

/**
 * Strip the `comment` field — prose for whoever edits the catalog, never data.
 * A destructure-rest, so every other field survives generically: a field added
 * to a schema can not be silently dropped here.
 */
function withoutComment<T extends { comment?: string | undefined }>(entry: T): Omit<T, 'comment'> {
  const { comment: _comment, ...rest } = entry
  return rest
}

const parsed = catalogSchema.parse(catalog)

// Load-time invariant the per-entry schemas cannot express: a hosted preset
// must have a data policy, or Settings silently shows "Data policy unknown"
// next to a provider we ship. (Local presets need none: data stays on-device.)
{
  const policySlugs = new Set(parsed.dataPolicies.flatMap((policy) => policy.slugs))
  for (const preset of parsed.presets) {
    if (preset.baseUrl.startsWith('http://')) continue // loopback-only, per the baseUrl refine
    if (!policySlugs.has(preset.id)) {
      throw new Error(`provider-metadata.json: hosted preset '${preset.id}' has no data policy`)
    }
  }
}

/** The presets in catalog order, which is picker and local-chip order. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = parsed.presets.map((preset) => ({
  ...withoutComment(preset),
  models: preset.models.map(withoutComment),
}))
export const PROVIDER_DATA_POLICIES: readonly ProviderDataPolicyEntry[] =
  parsed.dataPolicies.map(withoutComment)
export const PROVIDER_METADATA_LAST_VERIFIED = parsed.lastVerified
