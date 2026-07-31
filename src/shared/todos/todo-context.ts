import type { LLMMessage } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import { formatTodosForPrompt } from './todo-logic.ts'

const TODO_PIN_PREFIX = '\n\n---\n\n## Active plan (pinned)\n'

const FILES_TOUCHED_PREFIX = '\n\n---\n\n## Files touched so far (from compacted history)\n'

/** Max paths carried forward across compactions — bounded so a long plan can't grow this unboundedly. */
const MAX_TOUCHED_FILES = 24

/** Tool calls whose `path`/`paths` args are worth remembering past a compaction. */
const PATH_BEARING_TOOLS = new Set([
  'read_file',
  'write_file',
  'search_codebase',
  'find_files',
  'list_dir',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pathsFromArgs(args: unknown): string[] {
  if (!isRecord(args)) return []
  const found: string[] = []
  const { path, paths } = args
  if (typeof path === 'string' && path.trim()) found.push(path.trim())
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
 * After a todo item completes, compact history while keeping the pinned plan.
 * Drops oldest assistant/tool pairs; never removes user messages. The file paths
 * those dropped tool calls touched are kept (bounded, deduped) in a separate
 * pinned block so a still-in-progress item's later retries know where to look
 * instead of rediscovering it via fresh explore calls (#i2jsed).
 */
export function compactAtTodoBoundary(
  messages: LLMMessage[],
  todos: readonly TodoItem[],
  opts?: { keepRecentPairs?: number },
): boolean {
  const keepRecent = opts?.keepRecentPairs ?? 2
  if (messages.length <= keepRecent + 2) return false

  const start = messages[0]?.role === 'system' ? 1 : 0
  const system = messages[0]?.role === 'system' ? messages[0] : null
  const baseContent = system && typeof system.content === 'string' ? system.content : ''
  let touchedFiles = parseTouchedFiles(baseContent)

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

  const pinned = formatTodosForPrompt(todos)
  if (system && (pinned || touchedFiles.length > 0)) {
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

  return removed
}
