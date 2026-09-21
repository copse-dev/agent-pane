import type { ModelUsage } from '@shared/types'
import type { ServiceTier } from '@copse/llm/service-tier.ts'

export const USAGE_EVENTS_STORAGE_KEY = 'usageEvents'

/** Keep at least 90 days of events for the longest settings window. */
export const USAGE_EVENTS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

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
}
