import type { TodoItem } from './wire-types.ts'
import { isRecord } from './internal-utils.ts'

/** Tools that only gather context — repeating them often indicates a stuck loop. */
export const DUPLICATE_GUARDED_TOOL_NAMES = new Set([
  'explore',
  'list_dir',
  'read_file',
  'find_files',
  'search_code',
  'search_codebase',
  'semantic_search',
])

export function toolCallFingerprint(name: string, args: unknown): string {
  if (name === 'explore') {
    const parts = exploreFingerprintParts(args)
    if (parts) return `explore:${parts.scope}\0${parts.query}`
  }
  return `${name}:${stableJson(args)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
}

export function normalizeExploreArgs(name: string, args: unknown): unknown {
  if (name !== 'list_dir' || !isRecord(args)) return args
  const path = typeof args['path'] === 'string' ? args['path'].trim() || '.' : '.'
  return { ...args, path }
}

const EXPLORE_QUERY_NOISE = new Set([
  'a',
  'an',
  'and',
  'code',
  'detail',
  'details',
  'exact',
  'exactly',
  'find',
  'for',
  'implementation',
  'in',
  'including',
  'indentation',
  'line',
  'lines',
  'locate',
  'of',
  'on',
  'please',
  'precise',
  'show',
  'spaces',
  'the',
  'to',
  'whitespace',
  'with',
])

function words(value: string): string[] {
  const separated = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return separated.match(/[a-z0-9]+/g) ?? []
}

function normalizedQuery(value: string, paths: readonly string[] = []): string {
  const pathWords = new Set(paths.flatMap(words))
  return [
    ...new Set(
      words(value).filter(
        (word) =>
          !EXPLORE_QUERY_NOISE.has(word) && !pathWords.has(word) && !/^\d+(?:-\d+)?$/.test(word),
      ),
    ),
  ]
    .sort()
    .join(' ')
}

/** True when two normalized exploration queries carry substantially the same terms. */
export function isNearDuplicateQuery(left: string, right: string): boolean {
  const leftWords = new Set(words(left))
  const rightWords = new Set(words(right))
  if (leftWords.size === 0 || rightWords.size === 0) return false
  let intersection = 0
  for (const word of leftWords) {
    if (rightWords.has(word)) intersection++
  }
  const union = leftWords.size + rightWords.size - intersection
  const smaller = Math.min(leftWords.size, rightWords.size)
  return intersection / union >= 0.6 || (intersection >= 3 && intersection / smaller >= 2 / 3)
}

interface ExploreFingerprintParts {
  query: string
  scope: string
}

function exploreFingerprintParts(args: unknown): ExploreFingerprintParts | null {
  if (!isRecord(args) || typeof args['query'] !== 'string') return null
  const paths = Array.isArray(args['paths'])
    ? args['paths']
        .filter((path): path is string => typeof path === 'string')
        .map((path) => path.trim().replaceAll('\\', '/'))
        .sort()
    : []
  const scope: Record<string, unknown> = { paths }
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'query' && key !== 'paths') scope[key] = value
  }
  return { query: normalizedQuery(args['query'], paths), scope: stableJson(scope) }
}

function parseExploreFingerprint(fingerprint: string): ExploreFingerprintParts | null {
  const prefix = 'explore:'
  if (!fingerprint.startsWith(prefix)) return null
  const separator = fingerprint.indexOf('\0', prefix.length)
  if (separator < 0) return null
  return {
    scope: fingerprint.slice(prefix.length, separator),
    query: fingerprint.slice(separator + 1),
  }
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
  const current = parseExploreFingerprint(fp)
  if (!current) return false
  return recentFingerprints.some((recent) => {
    const previous = parseExploreFingerprint(recent)
    return (
      previous !== null &&
      previous.scope === current.scope &&
      isNearDuplicateQuery(previous.query, current.query)
    )
  })
}

export const LOOP_NUDGE_USER_MESSAGE =
  'Exploration is over. Do not call read, list, or search tools, and do not use run_shell or edit tools to inspect files. Use the results already gathered. If the user asked only for analysis, answer now. Otherwise perform only the requested command or edit, then answer.'

export const STUCK_FINALIZE_NUDGE =
  'Stop calling tools. Write a clear final answer for the user based on the conversation so far.'

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
