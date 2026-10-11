import type { ModelUsage } from '@shared/types'
import type { ServiceTier } from '@copse/llm/service-tier.ts'

/**
 * Directory (under the profile's user-data directory) holding the ledger: one
 * `YYYY-MM-DD.jsonl` file per UTC day, one JSON event per line, appended as calls
 * happen. It used to be a single array under the `usageEvents` config key, which
 * made every recorded call re-serialise the whole 90-day history and rewrite the
 * entire config.json. Day files are only ever appended to, and expire by being
 * deleted whole, so nothing is rewritten while events are being recorded.
 */
export const USAGE_EVENTS_DIR = 'usage-events'

/** The events that were still in config.json when the ledger moved to files. */
export const USAGE_EVENTS_MIGRATED_FILE = 'migrated.jsonl'

/** Where the ledger lived before it had its own files; read once to migrate it. */
export const LEGACY_USAGE_EVENTS_STORAGE_KEY = 'usageEvents'

export type UsageSource = 'agent' | 'small-tasks' | 'safety-classifier' | 'advisor' | 'classifier'

export interface UsageEvent extends ModelUsage {
  at: number
  model: string
  source: UsageSource
  projectId?: string
  threadId?: string
  /** Token counts are a local estimate (agent didn't report usage), not exact. */
  estimated?: boolean
  /** The first-party OpenAI tier Copse asked for on this call. */
  requestedServiceTier?: ServiceTier
  /** The OpenAI tier the completed response reports it actually used. */
  responseServiceTier?: ServiceTier
  /**
   * The upstream provider a router (OpenRouter) reports actually served this
   * call; never inferred. Prompt caches are per upstream, so a change between
   * consecutive calls explains a cache miss Copse's request bytes do not.
   */
  hostingProvider?: string
  /**
   * The saved classifier connection that served a `classifier` call (its label
   * when the call was made). Classifier tokens are not chat-model tokens, so
   * aggregation groups them by this and `model` instead of mixing them into the
   * cloud/local model tables.
   */
  provider?: string
}

export interface UsageRecordInput extends ModelUsage {
  model: string
  source: UsageSource
  projectId?: string
  threadId?: string
  at?: number
  /** Token counts are a local estimate (agent didn't report usage), not exact. */
  estimated?: boolean
  requestedServiceTier?: ServiceTier
  responseServiceTier?: ServiceTier
  hostingProvider?: string
  provider?: string
}
