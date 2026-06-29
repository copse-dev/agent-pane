// A custom (user-added) OpenAI-compatible provider is identified by a single,
// stable slug derived from its base-URL hostname. That one slug does double duty:
//   - model-selection encoding: `<slug>:<modelId>` (mirrors `mistral:` etc.)
//   - API-key lookup id:        `apiKey.<slug>`
// so there is no separate id to generate or ask the user for. The slug is a pure
// function of the hostname, so it is deterministic; callers freeze it on the
// stored record at creation time so editing the URL host later never orphans the
// saved key or model selections.

/** Slugs reserved by built-in providers; a custom slug must never collide. */
export const RESERVED_PROVIDER_SLUGS: readonly string[] = [
  'anthropic',
  'openai',
  'cursor',
  'openrouter',
  'lmstudio',
  'mistral',
  'gemini',
  'deepseek',
]

/** Lowercase, collapse non-alphanumerics to single dashes, trim leading/trailing dashes. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Predict a clean, URL-safe provider slug from an OpenAI-compatible base URL.
 *
 * Uses the registrable primary label, dropping a leading `api.`/`www.`:
 *   https://api.mistral.ai/v1                       → "mistral"
 *   https://api.deepseek.com                        → "deepseek"
 *   https://openrouter.ai/api/v1                    → "openrouter"
 *   http://localhost:1234/v1                        → "localhost"
 *   https://generativelanguage.googleapis.com/...   → "googleapis"
 *
 * Returns `''` for an unparseable URL so callers can prompt for a manual slug.
 * This is only the *default* — the add-provider form lets the user edit it (e.g.
 * to rename the Gemini-style `googleapis` case) before it is frozen on the record.
 */
export function providerSlugFromBaseUrl(baseUrl: string): string {
  let host: string
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase()
  } catch {
    return ''
  }
  if (!host) return ''

  // Loopback / bare IP: there is no meaningful domain label, so slug the whole host.
  if (host === 'localhost' || /^\d+(\.\d+)*$/.test(host)) return slugify(host)

  const labels = host.split('.').filter(Boolean)
  // Drop a leading `api.`/`www.` so api.mistral.ai resolves to mistral.ai.
  if (labels.length > 2 && (labels[0] === 'api' || labels[0] === 'www')) labels.shift()
  // Primary registrable label is the one just left of the public suffix
  // (mistral.ai → mistral, deepseek.com → deepseek). For multi-part TLDs like
  // `.co.uk` this picks the SLD label, which is still stable and unique per host.
  const primary = (labels.length >= 2 ? labels[labels.length - 2] : labels[0]) ?? ''
  return slugify(primary)
}

/**
 * Resolve the final slug for a new custom provider: the predicted (or manually
 * entered) base, disambiguated against reserved and already-taken slugs.
 *
 * - Empty input falls back to "provider".
 * - A collision with a reserved built-in slug, or with one of `taken`, gets a
 *   numeric suffix (`mistral` → `mistral-2`) so the new provider stays distinct.
 *   (Callers that want to *reuse* the matching built-in should check
 *   RESERVED_PROVIDER_SLUGS before calling this.)
 */
export function uniqueProviderSlug(desired: string, taken: readonly string[] = []): string {
  const base = slugify(desired) || 'provider'
  const used = new Set<string>([...RESERVED_PROVIDER_SLUGS, ...taken])
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${String(n)}`
    if (!used.has(candidate)) return candidate
  }
}
