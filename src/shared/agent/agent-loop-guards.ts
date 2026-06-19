/** Tools that only gather context — repeating them often indicates a stuck loop. */
export const EXPLORE_TOOL_NAMES = new Set(['list_dir', 'read_file', 'find_files', 'search_code'])

export function toolCallFingerprint(name: string, args: unknown): string {
  return `${name}:${stableJson(args)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
}

export function normalizeExploreArgs(name: string, args: unknown): unknown {
  if (name !== 'list_dir' || !args || typeof args !== 'object') return args
  const a = args as Record<string, unknown>
  const path = typeof a.path === 'string' ? a.path.trim() || '.' : '.'
  return { ...a, path }
}

export function isDuplicateExploreCall(
  name: string,
  args: unknown,
  recentFingerprints: readonly string[],
): boolean {
  if (!EXPLORE_TOOL_NAMES.has(name)) return false
  const fp = toolCallFingerprint(name, normalizeExploreArgs(name, args))
  return recentFingerprints.includes(fp)
}

export const LOOP_NUDGE_USER_MESSAGE =
  'You already explored this workspace. Use the tool results above — run the requested command with run_shell or write your final answer. Do not list the root directory again or re-read the same files.'

export const STUCK_FINALIZE_NUDGE =
  'Stop calling tools. Write a clear final answer for the user based on the conversation so far.'

export const DUPLICATE_TOOL_RESULT_PREFIX =
  '[Duplicate tool call skipped — same arguments as a recent step. Use prior results, run_shell if needed, or answer in text.]'
