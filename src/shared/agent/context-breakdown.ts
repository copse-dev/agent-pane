import type {
  ContextBreakdown,
  ContextBreakdownSegment,
  ContextSegmentKey,
} from '@shared/types/thread.ts'

/** Human-readable labels for each context segment, shown in the wheel popover. */
export const CONTEXT_SEGMENT_LABELS: Record<ContextSegmentKey, string> = {
  system: 'System prompt',
  tools: 'Tools',
  mcp: 'MCP tools',
  skills: 'Skills',
  history: 'Conversation',
  message: 'Your message',
}

/** Stable render order for segments (ring arcs and popover rows follow this). */
export const CONTEXT_SEGMENT_ORDER: ContextSegmentKey[] = [
  'system',
  'tools',
  'mcp',
  'skills',
  'history',
  'message',
]

/**
 * Turn raw per-part token estimates into an ordered breakdown. Rounds each part,
 * drops empty parts, and sums the total. Pure so it can be unit-tested without
 * the registry, settings, or filesystem.
 */
export function composeContextBreakdown(
  tokensByKey: Partial<Record<ContextSegmentKey, number>>,
  contextWindow: number,
): ContextBreakdown {
  const segments: ContextBreakdownSegment[] = []
  let totalTokens = 0
  for (const key of CONTEXT_SEGMENT_ORDER) {
    const tokens = Math.max(0, Math.round(tokensByKey[key] ?? 0))
    totalTokens += tokens
    if (tokens > 0) segments.push({ key, label: CONTEXT_SEGMENT_LABELS[key], tokens })
  }
  return { segments, totalTokens, contextWindow: Math.max(0, Math.round(contextWindow)) }
}
