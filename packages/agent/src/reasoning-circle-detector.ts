/** High-confidence reasons that an in-progress reasoning stream is circling. */
export type ReasoningCircleSignal =
  | 'self_reported_circle'
  | 'repeated_block'
  | 'repeated_sentence'
  | 'repeated_tail'
  | 'repeated_heading'
  | 'repeated_plan'
  | 'runaway_list'
  | 'repeated_turn'

export interface ReasoningCircleDetectorOptions {
  /** Exact normalized prose blocks of at least this size may count as repeats. */
  minRepeatedBlockChars: number
  /** Exact normalized sentences of at least this size may count as repeats. */
  minRepeatedSentenceChars: number
  /** A block, sentence, heading, or plan must recur this many times before it is a signal. */
  repeatLimit: number
  /** Consecutive list items fingerprinted as one repeated plan unit. */
  planWindowItems: number
  /** A reasoning-only list at or above this size is treated as runaway enumeration. */
  maxListItems: number
  /** Smallest verbatim unit considered when testing the tail for a repeating cycle. */
  minRepeatedTailChars: number
  /** Largest verbatim unit considered when testing the tail for a repeating cycle. */
  maxRepeatedTailChars: number
  /**
   * Smallest whole-turn text considered when comparing turns for an exact
   * cross-turn repeat. Lower than the block/sentence minimums: two entire,
   * separately-generated turns matching by chance is far less likely than a
   * phrase recurring inside one turn's prose, so a short exact match is still
   * a strong signal.
   */
  minRepeatedTurnChars: number
}

export const DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS: ReasoningCircleDetectorOptions = {
  minRepeatedBlockChars: 120,
  minRepeatedSentenceChars: 80,
  repeatLimit: 3,
  planWindowItems: 3,
  maxListItems: 100,
  minRepeatedTailChars: 40,
  maxRepeatedTailChars: 2_000,
  minRepeatedTurnChars: 24,
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

/** Prose lines outside fenced code, which is where circling shows up. */
function proseLines(reasoning: string): string[] {
  const lines: string[] = []
  let inFence = false
  for (const line of reasoning.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) lines.push(line)
  }
  return lines
}

/**
 * A token-level repeat loop streams one unbroken wall of prose — no blank lines,
 * headings, or list markers — so {@link repeatedBlock} never sees a second block
 * to compare. Split that wall into sentences instead and look for a long one the
 * model has emitted verbatim several times.
 */
function repeatedSentence(reasoning: string, options: ReasoningCircleDetectorOptions): boolean {
  const sentences = proseLines(reasoning)
    .join('\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalized)
    .filter((sentence) => sentence.length >= options.minRepeatedSentenceChars)
  return repeatedValue(sentences, options.repeatLimit)
}

/**
 * Catch a repeat loop that never reaches sentence punctuation (a fragment, a
 * line of code, a bare phrase) by testing whether the stream *ends* in a
 * verbatim cycle: the last three units of some period are byte-identical.
 * Bounded by `maxRepeatedTailChars` so the scan stays cheap at each checkpoint.
 */
function repeatedTail(reasoning: string, options: ReasoningCircleDetectorOptions): boolean {
  const tail = normalized(reasoning)
  const maxPeriod = Math.min(options.maxRepeatedTailChars, Math.floor(tail.length / 3))
  for (let period = options.minRepeatedTailChars; period <= maxPeriod; period++) {
    const last = tail.slice(tail.length - period)
    if (
      last === tail.slice(tail.length - period * 2, tail.length - period) &&
      last === tail.slice(tail.length - period * 3, tail.length - period * 2)
    ) {
      return true
    }
  }
  return false
}

function reasoningHeadings(reasoning: string): string[] {
  const headings: string[] = []
  for (const line of proseLines(reasoning)) {
    const heading = MARKDOWN_HEADING.exec(line)?.[1] ?? PLAIN_HEADING.exec(line)?.[1]
    if (heading) headings.push(normalized(heading))
  }
  return headings
}

function reasoningListItems(reasoning: string): string[] {
  const items: string[] = []
  for (const line of proseLines(reasoning)) {
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
  if (repeatedSentence(reasoning, options)) signals.push('repeated_sentence')
  if (repeatedTail(reasoning, options)) signals.push('repeated_tail')
  if (repeatedValue(reasoningHeadings(reasoning), options.repeatLimit)) {
    signals.push('repeated_heading')
  }
  const listItems = reasoningListItems(reasoning)
  if (repeatedPlan(listItems, options)) signals.push('repeated_plan')
  if (listItems.length >= options.maxListItems) signals.push('runaway_list')
  return signals
}

/**
 * The subset of {@link detectReasoningCircle}'s signals safe to apply to plain
 * visible output, not just reasoning. `repeated_block` and `repeated_sentence`
 * require a verbatim paragraph or long sentence recurring several times,
 * which prose, code, and formatted answers essentially never do by
 * coincidence. Deliberately excluded: `repeated_tail` flags any run of a
 * short repeating motif (indentation, separators, list markers), which is
 * routine in legitimate code and formatted output and would misfire
 * constantly outside prose; `self_reported_circle`, headings, and plans are
 * reasoning-specific framing a finished answer would not use to describe
 * itself.
 */
export function detectTextRepeatCircle(
  text: string,
  options: ReasoningCircleDetectorOptions = DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS,
): ReasoningCircleSignal[] {
  if (!text.trim()) return []
  const signals: ReasoningCircleSignal[] = []
  if (repeatedBlock(text, options)) signals.push('repeated_block')
  if (repeatedSentence(text, options)) signals.push('repeated_sentence')
  return signals
}

/**
 * Detect the same short output recurring verbatim across separate LLM calls.
 * Each call's own text may be far below `minRepeatedBlockChars` /
 * `minRepeatedSentenceChars`, so the within-text checks above never see it —
 * the caller is expected to carry `turns` forward across calls (unlike the
 * per-call accumulators `detectReasoningCircle` is normally fed with).
 * Compares whole turns exactly rather than splitting into blocks/sentences,
 * so a much smaller minimum length is still a safe, strong signal.
 */
export function detectCrossTurnCircle(
  turns: readonly string[],
  options: ReasoningCircleDetectorOptions = DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS,
): ReasoningCircleSignal[] {
  const normalizedTurns = turns
    .map(normalized)
    .filter((turn) => turn.length >= options.minRepeatedTurnChars)
  return repeatedValue(normalizedTurns, options.repeatLimit) ? ['repeated_turn'] : []
}

export interface ReasoningCheckpointPolicy {
  /** Token interval at which the current reasoning stream is reassessed. */
  intervalTokens: number
  /** Maximum non-reasoning output before the ordinary runaway cap applies. */
  maxNonReasoningTokens: number
  /** Maximum clean reasoning allowed before the ordinary runaway cap applies. */
  maxInitialTokens: number
  /** Maximum clean reasoning allowed after the one recovery nudge. */
  maxRecoveryTokens: number
  /**
   * Maximum reasoning allowed *after* a substantive answer has already streamed.
   * Reasoning past that point has nothing left to steer — the answer is out — so
   * it is checkpointed on its own budget instead of riding the much larger
   * non-reasoning ceiling. Absent leaves trailing reasoning to that ceiling.
   */
  maxTrailingReasoningTokens?: number
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
