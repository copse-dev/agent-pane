import type { TodoItem } from './wire-types.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

/**
 * Tools that only gather context — repeating them often indicates a stuck
 * loop. `explore` is a free-text summarizing subagent (`{ query, paths? }`),
 * not a raw filesystem read, but it is exactly the tool #1433's 43-minute run
 * thrashed on (15 calls, 0 `read_file` calls) and was previously missing here,
 * so `isDuplicateExploreCall` never fired for it at all.
 */
export const EXPLORE_TOOL_NAMES = new Set([
  'list_dir',
  'read_file',
  'find_files',
  'search_code',
  'search_codebase',
  'explore',
])

export function toolCallFingerprint(name: string, args: unknown): string {
  return `${name}:${stableJson(args)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
}

function normalizeExplorePaths(rawPaths: unknown): string[] {
  if (!Array.isArray(rawPaths)) return []
  return Array.from(
    new Set(rawPaths.filter((p) => typeof p === 'string').map((p) => p.trim())),
  ).sort()
}

/**
 * Normalizes tool args before fingerprinting. The result is also what
 * actually executes when a call turns out not to be a duplicate (see
 * `run-agent-loop.ts`'s `executeToolBatch`), so this only trims/sorts —
 * it must never change what the tool call means. Near-duplicate detection for
 * `explore`'s free-text `query` (tokenizing, dropping stopwords) happens
 * separately in `isDuplicateExploreCall`, over the fingerprint string, so the
 * executed args keep the model's actual wording.
 */
export function normalizeExploreArgs(name: string, args: unknown): unknown {
  if (name === 'list_dir') {
    if (!isRecord(args)) return args
    const path = typeof args['path'] === 'string' ? args['path'].trim() || '.' : '.'
    return { ...args, path }
  }
  if (name === 'explore') {
    if (!isRecord(args)) return args
    const query = typeof args['query'] === 'string' ? args['query'].trim() : args['query']
    const rawPaths = args['paths']
    return {
      ...args,
      query,
      ...(rawPaths !== undefined ? { paths: normalizeExplorePaths(rawPaths) } : {}),
    }
  }
  return args
}

/**
 * Small, generic stopword list for comparing two `explore` queries: glue
 * words that inflate token-set size without carrying meaning. Deliberately
 * conservative — this is a loop guard, not a search-quality feature.
 */
const EXPLORE_QUERY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'does',
  'for',
  'from',
  'get',
  'how',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'need',
  'of',
  'on',
  'or',
  'show',
  'tell',
  'that',
  'the',
  'this',
  'to',
  'want',
  'what',
  'when',
  'where',
  'which',
  'with',
  'you',
])

/** Lowercase, strip stopwords, dedupe and sort — see `EXPLORE_QUERY_STOPWORDS`. */
function tokenizeExploreQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !EXPLORE_QUERY_STOPWORDS.has(t))
  return Array.from(new Set(tokens)).sort()
}

/**
 * Two `explore` queries targeting the same `paths` are treated as a repeat
 * once their normalized token sets overlap at least this much AND share at
 * least `MIN_SHARED_EXPLORE_QUERY_TOKENS` tokens (both gates — see that
 * constant for why the ratio alone is not enough).
 *
 * Tuned against seven reconstructed #1433 queries paraphrasing the same
 * request, sharing a 4-word core ("urlInput keydown handler ... Enter"):
 * every one of them scores >= 0.5 against the first (`Q1 vs Q7` is the
 * tightest, at exactly 0.5 with 4 shared tokens) — raising the threshold any
 * higher would stop catching that pair as a direct repeat of the first call.
 * The full pairwise minimum across all 21 pairs (not just vs. the first) is
 * 0.4 (`Q6 vs Q7`, computed via `tokenizeExploreQuery`); every one of those
 * 21 pairs still shares >= 4 tokens, so `MIN_SHARED_EXPLORE_QUERY_TOKENS`
 * never excludes a real repeat here even where the ratio dips to 0.4.
 */
export const EXPLORE_QUERY_JACCARD_DUPLICATE_THRESHOLD = 0.5

/**
 * A ratio alone misclassifies short queries: "urlInput keydown handler" vs.
 * "urlInput blur handler" share only `{urlinput, handler}` (2 tokens) out of
 * 4 unique tokens total — a 0.5 ratio that would clear
 * `EXPLORE_QUERY_JACCARD_DUPLICATE_THRESHOLD` despite asking about two
 * different event handlers. Requiring at least this many *absolute* shared
 * tokens (not just a ratio) keeps a short, low-overlap pair like that one
 * from tripping the guard while still passing every #1433 repeat above,
 * where every pair shares >= 4 tokens (see the threshold's comment).
 */
export const MIN_SHARED_EXPLORE_QUERY_TOKENS = 4

/** Ratio + absolute shared-token overlap between two normalized token sets. */
function tokenOverlap(
  a: readonly string[],
  b: readonly string[],
): { jaccard: number; shared: number } {
  const setA = new Set(a)
  const setB = new Set(b)
  // Neither side carries content (e.g. a query that is all stopwords) — no
  // signal either way, so never treat it as an overlap match.
  if (setA.size === 0 || setB.size === 0) return { jaccard: 0, shared: 0 }
  let shared = 0
  for (const t of setA) {
    if (setB.has(t)) shared++
  }
  const union = setA.size + setB.size - shared
  return { jaccard: shared / union, shared }
}

interface ExploreQuerySignature {
  readonly tokens: readonly string[]
  readonly paths: readonly string[]
}

function samePathSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i])
}

/**
 * Recovers the tokenized query + normalized paths from a fingerprint string
 * produced by `toolCallFingerprint('explore', normalizeExploreArgs(...))`.
 * `stableJson`'s output is valid JSON (sorted keys, `JSON.stringify` leaves),
 * so this is a plain parse, not a heuristic.
 */
function parseExploreSignature(fingerprint: string): ExploreQuerySignature | null {
  const prefix = 'explore:'
  if (!fingerprint.startsWith(prefix)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(fingerprint.slice(prefix.length))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const query = typeof parsed['query'] === 'string' ? parsed['query'] : ''
  const paths = Array.isArray(parsed['paths'])
    ? parsed['paths'].filter((p) => typeof p === 'string')
    : []
  return { tokens: tokenizeExploreQuery(query), paths }
}

export function isDuplicateExploreCall(
  name: string,
  args: unknown,
  recentFingerprints: readonly string[],
): boolean {
  if (!EXPLORE_TOOL_NAMES.has(name)) return false
  const fp = toolCallFingerprint(name, normalizeExploreArgs(name, args))
  if (recentFingerprints.includes(fp)) return true
  if (name !== 'explore') return false

  // Free-text `query` args rarely match byte-for-byte even when they ask for
  // the same thing twice (#1433): fall back to token-overlap similarity
  // against prior `explore` calls that targeted the same `paths`. Both the
  // ratio and the absolute shared-token count must clear their thresholds —
  // see `MIN_SHARED_EXPLORE_QUERY_TOKENS` for why the ratio alone is not
  // enough (it misclassifies short, low-overlap queries as repeats).
  const current = parseExploreSignature(fp)
  if (!current) return false
  for (const prior of recentFingerprints) {
    const priorSignature = parseExploreSignature(prior)
    if (!priorSignature) continue
    if (!samePathSet(current.paths, priorSignature.paths)) continue
    const overlap = tokenOverlap(current.tokens, priorSignature.tokens)
    if (
      overlap.jaccard >= EXPLORE_QUERY_JACCARD_DUPLICATE_THRESHOLD &&
      overlap.shared >= MIN_SHARED_EXPLORE_QUERY_TOKENS
    ) {
      return true
    }
  }
  return false
}

export const LOOP_NUDGE_USER_MESSAGE =
  'Exploration is over. Do not call read, list, or search tools, and do not use run_shell or edit tools to inspect files. Use the results already gathered. If the user asked only for analysis, answer now. Otherwise perform only the requested command or edit, then answer.'

export const STUCK_FINALIZE_NUDGE =
  'Stop calling tools. Write a clear final answer for the user based on the conversation so far.'

/**
 * Consecutive `explore` calls tolerated with zero intervening `read_file`
 * calls before nudging (#1433). `explore` returns a prose summary with
 * approximate line numbers, not verbatim bytes; a run that only ever explores
 * never gets the exact text `str_replace` needs, so it keeps re-exploring
 * after every `old_string was not found` failure instead of reading the file.
 */
export const EXPLORE_WITHOUT_READ_NUDGE_THRESHOLD = 3

/**
 * Read-specific nudge for the explore-without-read pattern. Deliberately the
 * opposite instruction from `LOOP_NUDGE_USER_MESSAGE` (which tells the model
 * to stop reading/searching) — here the fix is to read the exact file before
 * editing, not to stop gathering context altogether.
 */
export const EXPLORE_WITHOUT_READ_NUDGE =
  'You have called explore several times in a row without calling read_file. explore returns a prose summary with approximate line numbers, not the verbatim bytes str_replace needs. Call read_file on the specific path you are about to edit, copy the exact text from its output, then retry the edit.'

/**
 * Tracks the explore/read_file interleaving for `EXPLORE_WITHOUT_READ_NUDGE`:
 * increments on each `explore` call, resets to 0 on `read_file`, and is
 * otherwise unaffected by other tools (a `str_replace` failure in between
 * does not itself reset or grow the streak).
 */
export function nextConsecutiveExploreWithoutRead(current: number, toolName: string): number {
  if (toolName === 'explore') return current + 1
  if (toolName === 'read_file') return 0
  return current
}

export const DUPLICATE_TOOL_RESULT_PREFIX =
  '[Duplicate tool call skipped — same arguments as a recent step. Use prior results, run_shell if needed, or answer in text.]'

/**
 * True while any todo is still pending or in progress. The `todo-finalize-closeout`
 * hook (and the closeout loop) use this so a run does not end with the plan
 * half-done.
 */
export function hasOpenTodos(todos: readonly TodoItem[]): boolean {
  return todos.some((t) => t.status === 'pending' || t.status === 'in_progress')
}

/** Max tool-enabled closeout turns while open todos remain at finalize. */
export const MAX_TODO_CLOSEOUT_ATTEMPTS = 3

export const OPEN_TODOS_FINALIZE_NUDGE = `You still have open todos in the plan. Before finishing:
1. Call update_todos (merge=true) to mark each finished item completed or cancel items you will not do.
2. If work remains, continue the pending/in_progress items — do not stop with open todos.
Do not reply with plain text claiming todos are done; the plan only updates via update_todos.`

export const OPEN_TODOS_FINALIZE_NUDGE_STRICT = `Open todos remain and were not updated. You MUST call update_todos now:
- merge=true, patch each item by id with status completed or cancelled, OR
- continue executing the remaining pending/in_progress work, then update_todos.
Plain-text claims that work is done are not accepted — update_todos is required.`

export const OPEN_TODOS_STILL_OPEN_MESSAGE =
  'Note: the task plan still has open items — the agent did not reconcile todos before finishing.'
