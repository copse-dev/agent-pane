/** High-confidence reasons that an in-progress reasoning stream is circling. */
export type ReasoningCircleSignal =
  'self_reported_circle' | 'repeated_block' | 'repeated_heading' | 'repeated_plan' | 'runaway_list'

export interface ReasoningCircleDetectorOptions {
  /** Exact normalized prose blocks of at least this size may count as repeats. */
  minRepeatedBlockChars: number
  /** A block, heading, or plan must recur this many times before it is a signal. */
  repeatLimit: number
  /** Consecutive list items fingerprinted as one repeated plan unit. */
  planWindowItems: number
  /** A reasoning-only list at or above this size is treated as runaway enumeration. */
  maxListItems: number
}

export const DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS: ReasoningCircleDetectorOptions = {
  minRepeatedBlockChars: 120,
  repeatLimit: 3,
  planWindowItems: 3,
  maxListItems: 100,
}

const SELF_REPORTED_CIRCLE_PATTERNS: readonly RegExp[] = [
  /\b(?:i(?:'m| am)|we(?:'re| are)) (?:going|running|stuck) (?:around )?in (?:a )?circles?\b/i,
  /\bi(?:'m| am) repeating myself\b/i,
  /\bi keep (?:repeating|re-?deriving|reconsidering)\b/i,
  /\bi (?:think )?i(?:'m| am) (?:overcomplicating this|confusing myself)\b/i,
]

const LIST_ITEM = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/
const MARKDOWN_HEADING = /^\s*#{1,6}\s+(.+?)\s*$/
const PLAIN_HEADING = /^\s*([^\n]{4,80}:)\s*$/

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function repeatedValue(values: readonly string[], repeatLimit: number): boolean {
  const counts = new Map<string, number>()
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1
    if (count >= repeatLimit) return true
    counts.set(value, count)
  }
  return false
}

function repeatedBlock(reasoning: string, options: ReasoningCircleDetectorOptions): boolean {
  const blocks = reasoning
    .split(/\n\s*\n/)
    .map(normalized)
    .filter((block) => block.length >= options.minRepeatedBlockChars)
  return repeatedValue(blocks, options.repeatLimit)
}

function reasoningHeadings(reasoning: string): string[] {
  const headings: string[] = []
  let inFence = false
  for (const line of reasoning.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = MARKDOWN_HEADING.exec(line)?.[1] ?? PLAIN_HEADING.exec(line)?.[1]
    if (heading) headings.push(normalized(heading))
  }
  return headings
}

function reasoningListItems(reasoning: string): string[] {
  const items: string[] = []
  let inFence = false
  for (const line of reasoning.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const item = LIST_ITEM.exec(line)?.[1]
    if (item) items.push(normalized(item))
  }
  return items
}

function repeatedPlan(items: readonly string[], options: ReasoningCircleDetectorOptions): boolean {
  if (items.length < options.planWindowItems * options.repeatLimit) return false
  const windows: string[] = []
  for (let index = 0; index <= items.length - options.planWindowItems; index++) {
    windows.push(items.slice(index, index + options.planWindowItems).join('\n'))
  }
  return repeatedValue(windows, options.repeatLimit)
}

/**
 * Detect only strong, locally explainable circle signals. Common planning words
 * such as "actually" and "wait" are deliberately excluded: retained benchmark
 * traces show that they are frequent in successful Qwen trajectories too.
 */
export function detectReasoningCircle(
  reasoning: string,
  options: ReasoningCircleDetectorOptions = DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS,
): ReasoningCircleSignal[] {
  if (!reasoning.trim()) return []
  const signals: ReasoningCircleSignal[] = []
  if (SELF_REPORTED_CIRCLE_PATTERNS.some((pattern) => pattern.test(reasoning))) {
    signals.push('self_reported_circle')
  }
  if (repeatedBlock(reasoning, options)) signals.push('repeated_block')
  if (repeatedValue(reasoningHeadings(reasoning), options.repeatLimit)) {
    signals.push('repeated_heading')
  }
  const listItems = reasoningListItems(reasoning)
  if (repeatedPlan(listItems, options)) signals.push('repeated_plan')
  if (listItems.length >= options.maxListItems) signals.push('runaway_list')
  return signals
}

export interface ReasoningCheckpointPolicy {
  /** Token interval at which the current reasoning stream is reassessed. */
  intervalTokens: number
  /** Maximum clean reasoning allowed before the ordinary runaway cap applies. */
  maxInitialTokens: number
  /** Maximum clean reasoning allowed after the one recovery nudge. */
  maxRecoveryTokens: number
}

export interface ReasoningCheckpointRecord {
  /** 1-based LLM call index within the run. */
  step: number
  checkpointTokens: number
  hardMaxTokens: number
  streamOutputChars: number
  streamReasoningChars: number
  visibleTextChars: number
  decision: 'continue' | 'cut'
  signals: ReasoningCircleSignal[]
}
