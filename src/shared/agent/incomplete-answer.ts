/**
 * Content-based incompleteness classifier.
 *
 * The provider stop-reason checks in `../llm/provider-stop-reason.ts` only fire
 * when the provider tells us a response was cut off (`length` / `max_tokens`).
 * Local / OpenAI-compatible servers (LM Studio, llama.cpp, many proxies) often
 * end the stream *without* a finish reason when they hit a completion or
 * context limit, so the agent loop receives an undefined stop reason and
 * accepts a visibly half-finished answer as final.
 *
 * `isLikelyIncompleteText` is a deterministic, high-precision heuristic that
 * catches the most common shapes of a silently-truncated answer so the loop can
 * ask the model to continue (bounded by {@link MAX_INCOMPLETE_CONTINUE_RETRIES}).
 * It is intentionally conservative: a false positive costs one extra LLM call,
 * so the signals here are ones that almost never end a genuinely finished reply.
 */

/** Trailing characters that can't end a finished answer (open or connective). */
const DANGLING_TRAILER_CHARS = /[,;:([{\-–—]$/

/** Punctuation / markup that legitimately ends a finished answer. */
const TERMINAL_ENDINGS = /[.!?)\]}"'`*_~>]$/

/**
 * Function words that, when they are the final token and there is no terminal
 * punctuation, indicate the sentence was cut off mid-clause.
 */
const DANGLING_TRAILER_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'of',
  'on',
  'or',
  'the',
  'their',
  'this',
  'to',
  'via',
  'was',
  'were',
  'which',
  'with',
])

/** True when `marker` occurs an odd number of times in `text` (unbalanced pair). */
function isUnbalanced(text: string, marker: RegExp): boolean {
  const matches = text.match(marker)
  return (matches?.length ?? 0) % 2 !== 0
}

/**
 * Returns true when `text` looks like a response that was cut off mid-stream,
 * even though the provider reported no truncation stop reason. Empty / blank
 * text returns false — an absent answer is handled separately by the loop.
 */
export function isLikelyIncompleteText(text: string): boolean {
  const trimmed = text.trimEnd()
  if (!trimmed) return false

  // 1) Unclosed fenced code block — the model stopped inside ``` ... ```.
  if (isUnbalanced(trimmed, /```/g)) return true

  // 2) Dangling inline-code backtick once complete fenced blocks are removed.
  //    Catches answers that stop mid-span, e.g. `…wrapped in \``.
  const withoutFences = trimmed.replace(/```[\s\S]*?```/g, '')
  if (isUnbalanced(withoutFences, /`/g)) return true

  // 3) Ends on an opening or connective character (comma, colon, dash, open
  //    bracket) — never a natural end to a finished reply.
  if (DANGLING_TRAILER_CHARS.test(trimmed)) return true

  // 4) Ends mid-clause on a dangling function word with no terminal punctuation.
  if (!TERMINAL_ENDINGS.test(trimmed)) {
    const lastWord = (trimmed.match(/[A-Za-z']+$/)?.[0] ?? '').toLowerCase()
    if (DANGLING_TRAILER_WORDS.has(lastWord)) return true
  }

  return false
}

/**
 * Max times the loop will ask the model to continue after detecting a
 * content-truncated answer the provider did not flag. Bounded so a model that
 * chronically trails off (common with small local models) cannot loop forever.
 */
export const MAX_INCOMPLETE_CONTINUE_RETRIES = 2

/** Surfaced to the user when an answer still looks truncated after retries. */
export const INCOMPLETE_ANSWER_NOTE =
  '\n\n_[This response may be incomplete — the model appears to have stopped mid-answer. Ask it to continue, or try a shorter prompt or a model with a larger context window.]_'
