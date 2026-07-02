import type { RequestPermissionRequest, ToolCallContent } from '@agentclientprotocol/sdk'
import { unwrapInlineCode } from './session-update-adapter.ts'

/**
 * Turn an external agent's `session/request_permission` into the title/body/type
 * the approval dialog shows, matching how native approvals read:
 *
 * - The dialog *title* is a short question per tool kind ('Run shell command?'),
 *   like the native prompts. The agent's own tool title is NOT the heading — for
 *   shell calls it is the entire command, which belongs in the monospace body.
 * - Edits render as a `- old` / `+ new` snippet diff, taken from the request's
 *   `diff` content block (or synthesized from `old_string`/`new_string` when the
 *   agent sends none) — never as raw `key: value` dumps of multi-line strings.
 * - Remaining scalar input fields become labelled lines; multi-line values are
 *   indented blocks; pretty JSON is the last resort for nested leftovers.
 */
export interface AcpApprovalPresentation {
  title: string
  body: string
  type: 'shell' | 'web' | 'mcp'
}

const FALLBACK_BODY = 'Run this tool call?'

/** Cap per rendered block (diff side, content text, multi-line scalar) so a
 * whole-file Write doesn't turn the approval dialog into a scroll marathon. */
const MAX_BLOCK_LINES = 40

export function presentPermissionRequest(
  agentTitle: string,
  req: RequestPermissionRequest,
): AcpApprovalPresentation {
  const kind = req.toolCall.kind ?? 'other'
  return {
    title: `${kindQuestion(kind)} — ${agentTitle}`,
    body: buildBody(req, kind),
    type: approvalTypeForToolKind(kind),
  }
}

/**
 * The approval dialog groups requests by a coarse type; map ACP's tool kind
 * onto the closest one so ACP prompts are styled like their native counterparts.
 */
function approvalTypeForToolKind(kind: string): 'shell' | 'web' | 'mcp' {
  if (kind === 'execute') return 'shell'
  if (kind === 'fetch') return 'web'
  return 'mcp'
}

/** Native-style question heading per ACP tool kind. */
function kindQuestion(kind: string): string {
  switch (kind) {
    case 'execute':
      return 'Run shell command?'
    case 'edit':
      return 'Edit a file?'
    case 'delete':
      return 'Delete a file?'
    case 'move':
      return 'Move a file?'
    case 'read':
      return 'Read a file?'
    case 'search':
      return 'Search the workspace?'
    case 'fetch':
      return 'Fetch from the web?'
    case 'think':
      return 'Run a subtask?'
    case 'switch_mode':
      return 'Switch agent mode?'
    default:
      return 'Run a tool?'
  }
}

/**
 * Human wording for what an "always allow" grant of this ACP tool kind covers.
 * ACP has no stable per-tool names (titles embed the concrete command), so the
 * grant is kind-wide and the label must say so.
 */
export function permissionKindLabel(kind: string): string {
  switch (kind) {
    case 'read':
      return 'file reads'
    case 'edit':
      return 'file edits'
    case 'delete':
      return 'deletions'
    case 'move':
      return 'file moves'
    case 'search':
      return 'searches'
    case 'execute':
      return 'terminal commands'
    case 'fetch':
      return 'web fetches'
    default:
      return `"${kind}" tool calls`
  }
}

function buildBody(req: RequestPermissionRequest, kind: string): string {
  const toolTitle = req.toolCall.title ? unwrapInlineCode(req.toolCall.title) : ''
  const input = req.toolCall.rawInput
  const record = isRecord(input) ? input : null
  const content = req.toolCall.content ?? []

  const segments: string[] = []
  const seen = new Set<string>()
  const push = (text: string | null | undefined): void => {
    const trimmed = text?.trimEnd()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    segments.push(trimmed)
  }
  // Input fields already rendered structurally (command line, diff) must not be
  // repeated by the labelled-scalar pass below.
  const skipKeys = new Set<string>()

  if (kind === 'execute') {
    // Like native shell prompts: the command bare on top, the agent's
    // description as its own paragraph.
    const command = typeof record?.['command'] === 'string' ? record['command'] : toolTitle
    push(command)
    skipKeys.add('command')
    if (typeof record?.['description'] === 'string') {
      push(record['description'])
      skipKeys.add('description')
    }
  } else {
    // Non-shell titles are descriptive ('Edit src/foo.ts', 'Read src/x.ts (1-20)').
    push(toolTitle)
  }

  const diffs = content.filter((c): c is ToolCallContent & { type: 'diff' } => c.type === 'diff')
  for (const diff of diffs) {
    push(renderDiff(diff.oldText, diff.newText))
  }
  if (diffs.length > 0) {
    for (const key of ['file_path', 'path', 'old_string', 'new_string', 'content']) {
      skipKeys.add(key)
    }
  } else if (record && editShaped(record, kind)) {
    // Agents that send no diff content block still get a readable diff when the
    // input follows the old_string/new_string (or edit-kind content) shape.
    const oldText = typeof record['old_string'] === 'string' ? record['old_string'] : null
    const newText =
      typeof record['new_string'] === 'string'
        ? record['new_string']
        : typeof record['content'] === 'string'
          ? record['content']
          : ''
    push(renderDiff(oldText, newText))
    skipKeys.add('old_string')
    skipKeys.add('new_string')
    if (kind === 'edit') skipKeys.add('content')
    // The tool title normally names the file; only fall back to the raw
    // file_path line when there is no title carrying it.
    if (toolTitle) skipKeys.add('file_path')
  }

  for (const block of content) {
    if (block.type === 'content' && block.content.type === 'text') {
      push(clampLines(unwrapInlineCode(block.content.text)))
    }
  }

  if (typeof input === 'string') {
    push(clampLines(unwrapInlineCode(input)))
  } else if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    push(String(input))
  } else if (record) {
    push(labelledScalarLines(record, skipKeys, seen))
  }

  return segments.join('\n\n') || toolTitle || FALLBACK_BODY
}

/** `key: value` lines for leftover scalars — multi-line values as indented
 * blocks — with pretty JSON as the fallback for nested structures. */
function labelledScalarLines(
  record: Record<string, unknown>,
  skipKeys: Set<string>,
  seen: Set<string>,
): string {
  const lines: string[] = []
  const nested: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (skipKeys.has(key) || value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = typeof value === 'string' ? unwrapInlineCode(value) : String(value)
      if (!text || seen.has(text)) continue
      lines.push(
        text.includes('\n') ? `${key}:\n${indentLines(clampLines(text))}` : `${key}: ${text}`,
      )
    } else {
      nested[key] = value
    }
  }
  if (Object.keys(nested).length > 0) {
    try {
      lines.push(JSON.stringify(nested, null, 2))
    } catch {
      // Non-serializable input (e.g. a circular structure); the scalar lines
      // (or the title) are enough for the user to make an approval decision.
    }
  }
  return lines.join('\n')
}

/** Whether the raw input looks like a file edit (Claude's Edit/Write shape). */
function editShaped(record: Record<string, unknown>, kind: string): boolean {
  if (typeof record['old_string'] === 'string' || typeof record['new_string'] === 'string')
    return true
  return kind === 'edit' && typeof record['content'] === 'string'
}

/** Snippet diff: removed lines prefixed `- `, added lines `+ `, each side
 * capped. `oldText` null/empty means a new file — only the added side shows. */
function renderDiff(oldText: string | null | undefined, newText: string): string {
  const lines = [...prefixedLines(oldText ?? '', '- '), ...prefixedLines(newText, '+ ')]
  return lines.join('\n')
}

function prefixedLines(text: string, prefix: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  const shown = lines.slice(0, MAX_BLOCK_LINES).map((line) => prefix + line)
  if (lines.length > MAX_BLOCK_LINES) {
    shown.push(`… (+${String(lines.length - MAX_BLOCK_LINES)} more lines)`)
  }
  return shown
}

function clampLines(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= MAX_BLOCK_LINES) return text
  return [
    ...lines.slice(0, MAX_BLOCK_LINES),
    `… (+${String(lines.length - MAX_BLOCK_LINES)} more lines)`,
  ].join('\n')
}

function indentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
