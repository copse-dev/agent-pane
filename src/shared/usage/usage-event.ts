import type { ModelUsage } from '@shared/types'
import type { ServiceTier } from '@copse/llm/service-tier.ts'

export const USAGE_EVENTS_STORAGE_KEY = 'usageEvents'

export type UsageSource = 'agent' | 'small-tasks' | 'safety-classifier' | 'advisor'

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
}
