import { TRACKED_MODELS } from './model-catalog.ts'

/**
 * Deterministic auto-suppression of older model versions within the same family.
 * When a new version of Opus/Sonnet/GPT-5/etc is released, older versions are
 * automatically suppressed without code changes.
 *
 * Family detection:
 * - Claude: `claude-{family}-{version}` → (opus|sonnet|fable|haiku) family
 * - GPT: `gpt-{version}[-{variant}]` → gpt version family (5, 5.5, 5.6, 6, etc.)
 */

interface ModelVersion {
  model: string
  family: string
  version: number[]
  variant?: string
}

/** Parse Claude model names: claude-opus-5-5 → { family: 'claude-opus', version: [5, 5] } */
function parseClaudeModel(id: string): ModelVersion | null {
  const match = id.match(/^claude-(opus|sonnet|fable|haiku)(?:-(\d+(?:-\d+)*))?/)
  if (!match) return null

  const family = `claude-${match[1]}`
  const versionStr = match[2] ?? '0'
  const version = versionStr.split('-').map(Number)

  return { model: id, family, version }
}

/** Parse GPT model names: gpt-5.6-sol → { family: 'gpt-5', version: [5, 6], variant: 'sol' } */
function parseGptModel(id: string): ModelVersion | null {
  const match = id.match(/^gpt-([\d.]+)(?:-(sol|terra|luna|mini|nano|astra))?/)
  if (!match) return null

  const versionStr = match[1]!
  // Convert "5.6" → [5, 6], "6.1" → [6, 1], "5" → [5]
  const parts = versionStr.split('.').map(Number)
  const version = parts
  const variant = match[2]
  // Group by major version only (5.0, 5.6, 6.1 all → gpt-5 or gpt-6)
  const majorVersion = parts[0]
  const family = `gpt-${majorVersion}`

  return {
    model: id,
    family,
    version,
    ...(variant && { variant }),
  }
}

/** Parse model name into family and version info. */
function parseModel(id: string): ModelVersion | null {
  if (id.startsWith('claude-')) return parseClaudeModel(id)
  if (id.startsWith('gpt-')) return parseGptModel(id)
  return null
}

/** Compare semantic versions: [5, 5] vs [5, 0] returns 1 (first is newer). */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const aVal = a[i] ?? 0
    const bVal = b[i] ?? 0
    if (aVal !== bVal) return aVal - bVal
  }
  return 0
}

/** Build a map of { family → latest version } from all tracked models. */
function buildLatestVersionMap(): Record<string, ModelVersion> {
  const latest: Record<string, ModelVersion> = {}

  for (const model of TRACKED_MODELS) {
    const parsed = parseModel(model)
    if (!parsed) continue

    const current = latest[parsed.family]
    if (!current || compareVersions(parsed.version, current.version) > 0) {
      latest[parsed.family] = parsed
    }
  }

  return latest
}

const latestByFamily = buildLatestVersionMap()

/**
 * Return true if this model should be suppressed (blocked) because a newer version
 * of the same family is available.
 */
export function isSuppressedByNewerVersion(model: string): boolean {
  const parsed = parseModel(model)
  if (!parsed) return false

  const latest = latestByFamily[parsed.family]
  if (!latest) return false

  // Suppress if this is not the latest version
  if (compareVersions(parsed.version, latest.version) < 0) return true

  // If versions are equal, variants don't affect suppression (both are kept)
  return false
}

/** Debug: show which models are suppressed and why. */
export function debugSuppressedModels(): Array<{
  model: string
  family: string
  reason: string
}> {
  const result: Array<{ model: string; family: string; reason: string }> = []

  for (const model of TRACKED_MODELS) {
    const parsed = parseModel(model)
    if (!parsed) continue

    const latest = latestByFamily[parsed.family]
    if (!latest) continue

    if (compareVersions(parsed.version, latest.version) < 0) {
      result.push({
        model,
        family: parsed.family,
        reason: `older version (${parsed.version.join('.')}) vs latest (${latest.version.join('.')})`,
      })
    }
  }

  return result
}
