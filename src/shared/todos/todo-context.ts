import type { LLMMessage } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import { formatTodosForPrompt } from './todo-logic.ts'

const TODO_PIN_PREFIX = '\n\n---\n\n## Active plan (pinned)\n'

const FILES_TOUCHED_PREFIX = '\n\n---\n\n## Files touched so far (from compacted history)\n'

/** Max paths carried forward across compactions — bounded so a long plan can't grow this unboundedly. */
const MAX_TOUCHED_FILES = 24

/**
 * Tool calls that name a file or directory the model has already located, so the
 * path is worth remembering past a compaction.
 *
 * Membership tracks the tools' real parameter schemas, not their names: a tool
 * whose only inputs are a pattern or a query locates nothing concrete and is
 * deliberately absent (`find_files` takes `pattern`; `git_*` take a path but
 * point at history rather than at the code a retry needs to re-open). The edit
 * tools matter most — `str_replace` is where a model that already knows the
 * codebase spends its calls, so leaving it out drops exactly the paths most
 * worth keeping.
 */
const PATH_BEARING_TOOLS = new Set([
  'read_file',
  'write_file',
  'str_replace',
  'read_staged_diff',
  'delete_file',
  'rename_file',
  'list_dir',
  'explore',
  'search_codebase',
  'search_code',
  'semantic_search',
])

/** Single-path arg names across {@link PATH_BEARING_TOOLS} (`rename_file` uses from/to). */
const PATH_ARG_KEYS = ['path', 'from', 'to']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathsFromArgs(args: unknown): string[] {
  if (!isRecord(args)) return []
  const found: string[] = []
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) found.push(value.trim())
  }
  const { paths } = args
  if (Array.isArray(paths)) {
    for (const p of paths) if (typeof p === 'string' && p.trim()) found.push(p.trim())
  }
  return found
}

/** Existing touched-files list already pinned in the system prompt, oldest first. */
function parseTouchedFiles(systemContent: string): string[] {
  const idx = systemContent.indexOf(FILES_TOUCHED_PREFIX)
  if (idx < 0) return []
  const rest = systemContent.slice(idx + FILES_TOUCHED_PREFIX.length)
  const nextMarker = rest.indexOf('\n\n---\n\n')
  const block = nextMarker >= 0 ? rest.slice(0, nextMarker) : rest
  return block
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean)
}

/** Merge newly-seen paths in, most-recent-last, capped to {@link MAX_TOUCHED_FILES}. */
function mergeTouchedFiles(existing: readonly string[], seen: readonly string[]): string[] {
  const ordered = [...existing]
  for (const path of seen) {
    const at = ordered.indexOf(path)
    if (at >= 0) ordered.splice(at, 1)
    ordered.push(path)
  }
  return ordered.slice(-MAX_TOUCHED_FILES)
}

function touchedFilesFromDroppedMessage(message: LLMMessage): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  const found: string[] = []
  for (const call of message.content) {
    if (!PATH_BEARING_TOOLS.has(call.name)) continue
    found.push(...pathsFromArgs(call.args))
  }
  return found
}

/**
 * Share of the conversation budget that must be in use before finishing a todo
 * is allowed to throw history away.
 *
 * Compaction exists to buy headroom, so below this it buys nothing and costs the
 * model everything it has learned. Measured on a real long-running thread (a
 * Tauri runtime migration on a 1M-token model), compaction fired seven times at a
 * conversation fill of 2-9% — roughly 10-13k tokens against a 1,046,552-token
 * budget. Each one reset the model to a one-line todo description, and it went on
 * to re-fetch the same PR reviews five times and oscillate between 60 and 0
 * compile errors without converging.
 *
 * Half the budget leaves the overflow trimmer (which runs per turn, and can drop
 * what this cannot) plenty of room to do its own job.
 */
export const TODO_COMPACTION_MIN_FILL_RATIO = 0.5

/**
 * After a todo item completes, compact history while keeping the pinned plan.
 * Drops oldest assistant/tool pairs; never removes user messages. The file paths
 * those dropped tool calls touched are kept (bounded, deduped) in a separate
 * pinned block so a still-in-progress item's later retries know where to look
 * instead of rediscovering it via fresh explore calls (#i2jsed).
 *
 * `fillRatio` is the conversation's current share of its token budget. Below
 * {@link TODO_COMPACTION_MIN_FILL_RATIO} the history is left alone — the pinned
 * blocks are still rewritten, since the plan has to track the todos either way.
 * Omit it to compact unconditionally (the pre-gate behaviour, kept for callers
 * with no budget to measure against).
 */
export function compactAtTodoBoundary(
  messages: LLMMessage[],
  todos: readonly TodoItem[],
  opts?: { keepRecentPairs?: number; fillRatio?: number },
): boolean {
  const keepRecent = opts?.keepRecentPairs ?? 2
  if (messages.length <= keepRecent + 2) return false

  const start = messages[0]?.role === 'system' ? 1 : 0
  const system = messages[0]?.role === 'system' ? messages[0] : null
  const baseContent = system && typeof system.content === 'string' ? system.content : ''
  let touchedFiles = parseTouchedFiles(baseContent)

  // Rewrites both pinned blocks from the current todos and touched-file list.
  // Every exit path calls this, including the gated one that drops no history:
  // the pin is what keeps the plan in the system prompt in step with the todos,
  // so returning early without it would leave the previous plan pinned while the
  // todos moved on.
  const writePinnedBlocks = (): void => {
    const pinned = formatTodosForPrompt(todos)
    if (!system || (!pinned && touchedFiles.length === 0)) return
    // Both pinned blocks are always written together (files block first, see
    // below), so the old-content cutoff is whichever marker appears first —
    // using only the todo marker would leave a stale files block in place and
    // stack duplicates call over call.
    const markerIndexes = [
      baseContent.indexOf(FILES_TOUCHED_PREFIX),
      baseContent.indexOf(TODO_PIN_PREFIX),
    ].filter((i) => i >= 0)
    const cut = markerIndexes.length > 0 ? Math.min(...markerIndexes) : -1
    const withoutOldPins = cut >= 0 ? baseContent.slice(0, cut) : baseContent
    const filesBlock =
      touchedFiles.length > 0
        ? FILES_TOUCHED_PREFIX + touchedFiles.map((p) => `- ${p}`).join('\n')
        : ''
    const todoBlock = pinned ? TODO_PIN_PREFIX + pinned.trim() : ''
    messages[0] = { role: 'system', content: withoutOldPins + filesBlock + todoBlock }
  }

  const fillRatio = opts?.fillRatio
  if (fillRatio !== undefined && fillRatio < TODO_COMPACTION_MIN_FILL_RATIO) {
    writePinnedBlocks()
    return false
  }

  let removed = false
  while (messages.length - start > keepRecent + 1) {
    let dropIndex = -1
    for (let i = start; i < messages.length; i++) {
      const m = messages[i]
      if (!m || m.role === 'user') continue
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const next = messages[i + 1]
        if (next?.role === 'tool') {
          dropIndex = i
          break
        }
      }
      if (m.role === 'assistant' && typeof m.content === 'string') {
        dropIndex = i
        break
      }
    }
    if (dropIndex < 0) break
    const dropMsg = messages[dropIndex]
    if (dropMsg)
      touchedFiles = mergeTouchedFiles(touchedFiles, touchedFilesFromDroppedMessage(dropMsg))
    const span =
      dropMsg?.role === 'assistant' &&
      Array.isArray(dropMsg.content) &&
      messages[dropIndex + 1]?.role === 'tool'
        ? 2
        : 1
    messages.splice(dropIndex, span)
    removed = true
  }

  writePinnedBlocks()

  return removed
}
