import { READ_FILE_LIMITS_CEILING } from './read-file-limits.ts'
import type { TodoItem } from './wire-types.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

/**
 * Tools whose calls the duplicate guard fingerprints: they only gather context,
 * so repeating one often indicates a stuck loop. `explore` is a free-text
 * summarizing subagent (`{ query, paths? }`), not a raw filesystem read, but it
 * is exactly the tool #1433's 43-minute run thrashed on (15 calls, 0
 * `read_file` calls) and was previously missing here, so
 * `isDuplicateExploreCall` never fired for it at all.
 *
 * Not to be confused with `SUBAGENT_ALLOWED_TOOL_NAMES` (`run-subagent.ts`),
 * the explore subagent's allow-list. Both were once named
 * `EXPLORE_TOOL_NAMES`; adding `explore` to that one would let the subagent
 * spawn subagents.
 */
export const DUPLICATE_GUARDED_TOOL_NAMES = new Set([
  'list_dir',
  'read_file',
  'find_files',
  'search_code',
  'search_codebase',
  'semantic_search',
  'explore',
  'read_explored',
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
 * `run-agent-loop.ts`'s `executeToolBatch`), so this preserves the effective request. File reads also canonicalize
 * their existing line ceiling; asking for more cannot return more lines. Near-duplicate detection for
 * `explore`'s free-text `query` (tokenizing, dropping stopwords) happens
 * separately in `isDuplicateExploreCall`, over the fingerprint string, so the
 * executed args keep the model's actual wording.
 */
export function normalizeExploreArgs(name: string, args: unknown): unknown {
  if (name === 'read_file' && isRecord(args)) {
    const start = typeof args['start_line'] === 'number' ? args['start_line'] : 1
    const ceiling = start + READ_FILE_LIMITS_CEILING.maxLines - 1
    const end = typeof args['end_line'] === 'number' ? Math.min(args['end_line'], ceiling) : ceiling
    return { ...args, start_line: start, end_line: end }
  }
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
  if (!DUPLICATE_GUARDED_TOOL_NAMES.has(name)) return false
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
 * Explore-mode counterpart of `EXPLORE_WITHOUT_READ_NUDGE`. The parent has no
 * `read_file` there; the exact bytes are the verbatim-excerpt blocks appended
 * to each explore result (#1433, Fix 0), so naming read_file would send the
 * model after a tool it cannot call.
 */
export const EXPLORE_REPEAT_USE_EXCERPTS_NUDGE =
  'You have called explore several times in a row. Each explore result already ends with verbatim excerpts of the lines it read, copied from the files byte-for-byte. Copy str_replace old_string from those excerpt blocks, not from the prose summary, and make the edit. If no excerpt covers the lines you need, call read_explored with the path and lines; explore again only if exploration never read them.'

/**
 * Tracks the explore/read_file interleaving for `EXPLORE_WITHOUT_READ_NUDGE`:
 * increments on each `explore` call, resets to 0 on `read_file`, and is
 * otherwise unaffected by other tools (a `str_replace` failure in between
 * does not itself reset or grow the streak).
 */
export function nextConsecutiveExploreWithoutRead(current: number, toolName: string): number {
  if (toolName === 'explore') return current + 1
  // read_explored quotes exact bytes in explore mode, as read_file does elsewhere.
  if (toolName === 'read_file' || toolName === 'read_explored') return 0
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

/**
 * True when one step's todo update closed the plan on checks (#1433, Fix 4):
 * todos were open before the step, none are open after it, at least one item is
 * completed, and every item the step completed carries an acceptance `check`.
 * A `check` on a completed item has been executed and passed: the host's
 * update_todos runs it before accepting `completed`, holds back a check that
 * arrived in the completing call, and reverts a failing one to `in_progress`.
 * So this is the plan's own terminal step having been verified, not the model
 * asserting it. Plans closed without checks are left alone, and the run
 * finishes the way it always has.
 */
export function planClosedByVerifiedChecks(
  before: readonly TodoItem[],
  after: readonly TodoItem[],
): boolean {
  if (!hasOpenTodos(before) || hasOpenTodos(after)) return false
  const wasCompleted = new Set(before.filter((t) => t.status === 'completed').map((t) => t.id))
  const closedNow = after.filter((t) => t.status === 'completed' && !wasCompleted.has(t.id))
  return closedNow.length > 0 && closedNow.every((t) => t.check !== undefined)
}

export const PLAN_VERIFIED_FINALIZE_NUDGE =
  "Every item in your plan is completed and the final item's acceptance check passed, so the task is done. Do not run more checks, re-verify, or inspect the repository again. Write the final answer for the user now: what changed, how it was verified, and anything left for them to do."

/** Splits a shell command on `&&`, `||` and `;` into trimmed, non-empty segments. */
function shellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** A stderr-to-stdout merge, the one redirection that writes no file. */
const STDERR_MERGE = /\s*\d?>&\d\b/g

/**
 * Output filters that only reshape what the model sees of a command's output,
 * so `pnpm test | tail -50` and `pnpm test 2>&1 | grep fail` are the same run.
 */
const OUTPUT_FILTER = /^(?:tail|head|grep|egrep|rg|wc|sort|uniq|cat|less|more)(?:\s|$)/

/**
 * Whole-suite verification invocations: test, check, lint, typecheck and build
 * scripts through a package manager or make, and the common direct runners.
 */
const VERIFICATION_INVOCATION =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|verify)(?::[\w:-]+)?|(?:npx\s+|pnpm\s+exec\s+)?(?:vitest|jest|tsc|eslint|oxlint|mocha)|make\s+(?:test|check|lint|build)|cargo\s+(?:test|check|build|clippy)|go\s+(?:test|vet|build)|pytest|python3?\s+-m\s+pytest|tox|mvn\s+(?:test|verify)|\.?\/?gradlew?\s+(?:test|check|build))(?:\s|$)/

/** Flags that make a verification command write (fix, format, update snapshots). */
const WRITING_FLAG = /(?:^|\s)(?:--fix|--write|-u|--update-snapshots?|-w)(?:\s|=|$)/

/** A segment's pipeline stages, or null when it redirects output to a file. */
function pipelineStages(segment: string): string[] | null {
  const merged = segment.replace(STDERR_MERGE, '')
  if (merged.includes('>')) return null
  return merged.split('|').map((p) => p.replace(/\s+/g, ' ').trim())
}

/**
 * The repeat-damping key for a `run_shell` command, or null when it is not a
 * whole-suite verification run (#1433, Fix 4). `cd` segments are kept in the
 * key (the same suite in another package is a different run); output filters
 * are dropped; any other segment, a file redirection, or a writing flag makes
 * the command ineligible, since it may change state.
 */
export function verificationCommandKey(command: string): string | null {
  const parts: string[] = []
  let verifies = false
  for (const segment of shellSegments(command)) {
    const stages = pipelineStages(segment)
    if (!stages) return null
    const [producer = '', ...filters] = stages
    if (filters.some((f) => !OUTPUT_FILTER.test(f))) return null
    if (/^cd\s/.test(producer)) {
      parts.push(producer)
      continue
    }
    if (!VERIFICATION_INVOCATION.test(producer) || WRITING_FLAG.test(producer)) return null
    verifies = true
    parts.push(producer)
  }
  return verifies ? parts.join(' && ') : null
}

/**
 * Read-only inspection a model typically runs between two verification passes
 * (#1433's run: `git status`, `git diff --stat`, `git show --stat`).
 */
const READ_ONLY_SHELL_STAGE =
  /^(?:cd|pwd|ls|cat|head|tail|wc|echo|which|rg|grep|egrep|sort|uniq|git\s+(?:status|diff|show|log|rev-parse|remote\s+-v|branch\s+--show-current))(?:\s|$)/

function isReadOnlyShellCommand(command: string): boolean {
  const segments = shellSegments(command)
  if (segments.length === 0) return false
  return segments.every((segment) => {
    const stages = pipelineStages(segment)
    return stages !== null && stages.every((stage) => READ_ONLY_SHELL_STAGE.test(stage))
  })
}

/** Tools that never change the workspace, so they do not re-arm verification. */
const WORKSPACE_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DUPLICATE_GUARDED_TOOL_NAMES,
  'update_todos',
  'read_skill',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'staged_diffs',
  'read_staged_diff',
])

function shellCommandOf(name: string, args: unknown): string | null {
  if (name !== 'run_shell' || !isRecord(args)) return null
  const command = args['command']
  return typeof command === 'string' ? command : null
}

/**
 * Remembers which verification commands ran since the last call that may have
 * changed the workspace (#1433, Fix 4). Re-running the same suite with nothing
 * changed reproduces the result already in context — the motivating run ran a
 * five-minute `npm run check` three times after its PR was up, re-diagnosing
 * the same pre-existing failures each time. Anything that might have changed
 * the tree — an edit tool, an unrecognized shell command, an unknown tool —
 * re-arms every command, so the guard errs toward letting a run verify.
 */
export class RepeatVerificationTracker {
  private readonly ran = new Set<string>()

  /** True when this call would repeat a verification run with nothing changed since. */
  isRepeat(name: string, args: unknown): boolean {
    const command = shellCommandOf(name, args)
    const key = command === null ? null : verificationCommandKey(command)
    return key !== null && this.ran.has(key)
  }

  /** Records a call that actually executed (not one that was skipped). */
  observe(name: string, args: unknown): void {
    const command = shellCommandOf(name, args)
    if (command !== null) {
      const key = verificationCommandKey(command)
      if (key !== null) {
        this.ran.add(key)
        return
      }
      if (isReadOnlyShellCommand(command)) return
    } else if (WORKSPACE_READ_ONLY_TOOL_NAMES.has(name)) {
      return
    }
    this.ran.clear()
  }

  /** Forgets every run, e.g. once trimming may have dropped their output from history. */
  reset(): void {
    this.ran.clear()
  }
}

export const REPEAT_VERIFICATION_RESULT_PREFIX =
  '[Verification skipped — this exact command already ran in this run and nothing that could change the workspace has happened since, so its result above still stands. Act on that result instead of re-running it, or answer.]'
