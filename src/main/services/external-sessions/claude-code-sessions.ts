import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Message, ToolCall } from '@shared/types'
import { isRecord } from '@shared/unknown-value.ts'
import {
  capToolResult,
  oneLineTitle,
  parseTimestamp,
  readJsonlRecords,
  readJsonlTail,
  titleFromPrompt,
  withoutHarnessText,
} from './session-files.ts'
import type { ExternalSessionFile, ParsedExternalSession } from './external-session-types.ts'

/**
 * Claude Code's saved sessions: one JSONL file per session under
 * `<config>/projects/<encoded cwd>/<session id>.jsonl`, where `<config>` is
 * `$CLAUDE_CONFIG_DIR` or `~/.claude`. Each line is one event; conversation
 * lines carry the Anthropic Messages API `message` plus `uuid`/`parentUuid`
 * links, so a rewound conversation is a tree whose active branch ends at the
 * last line.
 */

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['CLAUDE_CONFIG_DIR']
  return configured && configured.trim() ? configured : join(homedir(), '.claude')
}

/**
 * The directory name Claude Code files a cwd's sessions under: every character
 * that is not a letter or digit becomes `-`.
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

const HEADER_SCAN_BYTES = 2 * 1024 * 1024
/** Titles set later in a session (`/rename`, or the CLI's own naming) are near its end. */
const TAIL_SCAN_BYTES = 256 * 1024

/**
 * Session files whose folder name could belong to `root` or a folder inside it.
 * The encoding is lossy, so callers still check each file's recorded `cwd`.
 */
export async function listClaudeCodeSessionFiles(
  root: string,
  configDir = claudeConfigDir(),
): Promise<ExternalSessionFile[] | null> {
  const projectsDir = join(configDir, 'projects')
  const dirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => null)
  if (!dirs) return null
  const prefix = claudeProjectDirName(root)
  const files: ExternalSessionFile[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    if (dir.name !== prefix && !dir.name.startsWith(`${prefix}-`)) continue
    const entries = await readdir(join(projectsDir, dir.name), { withFileTypes: true }).catch(
      () => [],
    )
    for (const entry of entries) {
      // `agent-*.jsonl` files are subagent side-chains, not sessions of their own.
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('agent-'))
        continue
      const path = join(projectsDir, dir.name, entry.name)
      const info = await stat(path).catch(() => null)
      if (!info) continue
      files.push({ source: 'claude-code', path, updatedAt: info.mtimeMs, bytes: info.size })
    }
  }
  return files
}

/** The first lines of a session: enough for its list row. */
export async function readClaudeCodeSessionHeader(
  file: ExternalSessionFile,
): Promise<ParsedExternalSession | null> {
  const found: {
    cwd: string | null
    gitBranch: string | null
    startedAt: number | null
    title: string | null
    summary: string | null
    named: string | null
    aiTitle: string | null
  } = {
    cwd: null,
    gitBranch: null,
    startedAt: null,
    title: null,
    summary: null,
    named: null,
    aiTitle: null,
  }
  const noteTitle = (line: Record<string, unknown>): boolean => {
    if (line['type'] === 'custom-title') {
      // Rewritten after most turns; the last one carries any rename.
      const name = stringField(line, 'customTitle')?.trim()
      if (name) found.named = name
      return true
    }
    if (line['type'] === 'ai-title') {
      const name = stringField(line, 'aiTitle')?.trim()
      if (name) found.aiTitle = name
      return true
    }
    if (line['type'] === 'summary' && typeof line['summary'] === 'string') {
      found.summary ??= line['summary']
      return true
    }
    return false
  }
  await readJsonlRecords(
    file.path,
    (line) => {
      if (noteTitle(line)) return
      if (line['isSidechain'] === true) return
      found.cwd ??= stringField(line, 'cwd')
      found.gitBranch ??= stringField(line, 'gitBranch')
      found.startedAt ??= parseTimestamp(line['timestamp'])
      if (found.title === null && line['type'] === 'user') {
        const prompt = userPrompt(line)
        if (prompt?.text) found.title = titleFromPrompt(prompt.text)
      }
      // The CLI's titles come a few lines in; keep reading until one has.
      return found.cwd === null || (found.named === null && found.aiTitle === null)
    },
    { maxBytes: HEADER_SCAN_BYTES },
  )
  if (file.bytes > HEADER_SCAN_BYTES) {
    for (const line of await readJsonlTail(file.path, TAIL_SCAN_BYTES).catch(() => []))
      noteTitle(line)
  }
  const { cwd, gitBranch, startedAt, title, summary, named, aiTitle } = found
  if (cwd === null) return null
  const heading = named ?? aiTitle ?? summary ?? title
  if (heading === null) return null
  return {
    source: 'claude-code',
    sessionId: basename(file.path, '.jsonl'),
    cwd,
    ...(gitBranch ? { gitBranch } : {}),
    title: oneLineTitle(heading),
    startedAt: startedAt ?? file.updatedAt,
    updatedAt: file.updatedAt,
    messages: [],
  }
}

interface ClaudeLine {
  record: Record<string, unknown>
  uuid: string | null
  parent: string | null
  /** Position in the file. */
  index: number
}

function isMainConversationLine(line: ClaudeLine): boolean {
  return (
    (line.record['type'] === 'user' || line.record['type'] === 'assistant') &&
    line.record['isSidechain'] !== true
  )
}

/**
 * The conversation on the session's active branch, oldest first: walk back
 * from the last conversation line through `parentUuid`, crossing compaction
 * boundaries through `logicalParentUuid`.
 */
function activeBranch(lines: ClaudeLine[]): Record<string, unknown>[] {
  const byUuid = new Map<string, ClaudeLine>()
  for (const line of lines) if (line.uuid) byUuid.set(line.uuid, line)
  const leaf = lines.findLast(isMainConversationLine)
  // Without links (very old files), file order is the conversation order.
  if (!leaf?.uuid) return lines.map((line) => line.record)
  const branch: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let current: ClaudeLine | undefined = leaf
  while (current && current.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid)
    branch.push(current.record)
    if (!current.parent) break
    const before: number = current.index
    // A parent the file does not hold (long live sessions have such gaps):
    // carry on from the conversation line written just before.
    current =
      byUuid.get(current.parent) ??
      lines.findLast((line) => line.index < before && isMainConversationLine(line))
  }
  return branch.reverse()
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value ? value : null
}

/** Claude Code's markup for a slash command the user ran. */
function slashCommand(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim()
  if (!name) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

/** Lines the CLI wrote on the user's behalf rather than words they typed. */
function isCliNoise(text: string): boolean {
  const trimmed = text.trimStart()
  return (
    trimmed.startsWith('<local-command-stdout>') ||
    trimmed.startsWith('<local-command-stderr>') ||
    trimmed.startsWith('<local-command-caveat>') ||
    trimmed.startsWith('[Request interrupted by user')
  )
}

/**
 * Turns the CLI or its host started rather than the user: background task
 * notifications, CI monitor events and messages from other sessions. Newer
 * files say so in `turnOrigin`; the tag check in {@link withoutHarnessText}
 * covers older ones. Host-written turns (`host_synthetic`) stay: once their
 * injected context is stripped, what is left is often the session's brief.
 */
const HARNESS_TURN_ORIGINS = new Set(['task_notification', 'auto_continuation', 'peer'])

function isHarnessTurn(record: Record<string, unknown>): boolean {
  const turnOrigin = record['turnOrigin']
  if (typeof turnOrigin === 'string' && HARNESS_TURN_ORIGINS.has(turnOrigin)) return true
  const origin = record['origin']
  return isRecord(origin) && origin['kind'] === 'task-notification'
}

const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024

/** The user's own words (and pasted images) on a `user` line, or `null` for tool results. */
function userPrompt(record: Record<string, unknown>): { text: string; images: string[] } | null {
  if (record['isMeta'] === true || record['isCompactSummary'] === true) return null
  if (isHarnessTurn(record)) return null
  const message = record['message']
  if (!isRecord(message)) return null
  const content = message['content']
  const texts: string[] = []
  const images: string[] = []
  if (typeof content === 'string') texts.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block['type'] === 'text' && typeof block['text'] === 'string') texts.push(block['text'])
      if (block['type'] === 'image' && isRecord(block['source'])) {
        const source = block['source']
        const media = source['media_type']
        const data = source['data']
        if (source['type'] === 'base64' && typeof media === 'string' && typeof data === 'string') {
          const url = `data:${media};base64,${data}`
          if (url.length <= MAX_IMAGE_DATA_URL_CHARS) images.push(url)
        }
      }
    }
  }
  const words = texts
    .map((text) => slashCommand(text) ?? (isCliNoise(text) ? '' : withoutHarnessText(text)))
    .filter((text) => text.trim())
    .join('\n\n')
  if (!words && images.length === 0) return null
  return { text: words, images }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  let loadedTools = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
    else if (block['type'] === 'image') parts.push('[image]')
    else if (block['type'] === 'tool_reference') loadedTools += 1
  }
  if (loadedTools > 0)
    parts.push(`Loaded ${String(loadedTools)} ${loadedTools === 1 ? 'tool' : 'tools'}`)
  return parts.join('\n')
}

/**
 * Move a `user` line's tool results into `results`, capped, and drop them from
 * the line so a long session does not hold every output twice.
 */
function takeToolResults(
  record: Record<string, unknown>,
  results: Map<string, { text: string; failed: boolean }>,
): void {
  const message = record['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return
  for (const block of message['content']) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue
    const id = block['tool_use_id']
    if (typeof id !== 'string') continue
    results.set(id, {
      text: capToolResult(toolResultText(block['content'])),
      failed: block['is_error'] === true,
    })
    delete block['content']
  }
}

/** ACP tool kinds, so imported cards group and label like a live Claude agent's. */
const CLAUDE_TOOL_KINDS: Readonly<Record<string, string>> = {
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
}

function claudeToolTitle(name: string, input: unknown): string {
  if (!isRecord(input)) return name
  const pick = (key: string): string | null =>
    typeof input[key] === 'string' && input[key] ? input[key] : null
  switch (name) {
    case 'Bash':
      return pick('command') ? oneLineTitle(pick('command') ?? '', 120) : name
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return pick('file_path') ? `${name} ${pick('file_path') ?? ''}` : name
    case 'Grep':
      return pick('pattern') ? `grep "${pick('pattern') ?? ''}"` : name
    case 'Glob':
      return pick('pattern') ? `Find ${pick('pattern') ?? ''}` : name
    case 'WebFetch':
      return pick('url') ? `Fetch ${pick('url') ?? ''}` : name
    case 'WebSearch':
      return pick('query') ? `Search "${pick('query') ?? ''}"` : name
    case 'Task':
    case 'Agent':
      return pick('description') ? `Task: ${pick('description') ?? ''}` : name
    default:
      return name
  }
}

/** Every line of a Claude Code session file, as a Copse transcript. */
export async function readClaudeCodeSession(
  file: ExternalSessionFile,
): Promise<ParsedExternalSession | null> {
  const header = await readClaudeCodeSessionHeader(file)
  if (!header) return null
  const lines: ClaudeLine[] = []
  // Results are matched to their calls by id, wherever they sit: when Claude
  // Code runs tools in parallel, each result hangs off its own call, so all but
  // the last are off the active branch.
  const results = new Map<string, { text: string; failed: boolean }>()
  await readJsonlRecords(file.path, (record) => {
    if (record['type'] === 'user' && record['isSidechain'] !== true)
      takeToolResults(record, results)
    // Every linked line is part of the chain, not only conversation lines:
    // current Claude Code threads a turn through `attachment` records between
    // the prompt and the answer, and the walk back must cross them.
    const uuid = stringField(record, 'uuid')
    if (uuid === null && record['type'] !== 'user' && record['type'] !== 'assistant') return
    lines.push({
      record,
      uuid,
      parent: stringField(record, 'parentUuid') ?? stringField(record, 'logicalParentUuid'),
      index: lines.length,
    })
  })

  const messages: Message[] = []
  const toolCallsById = new Map<string, ToolCall>()
  let assistant: { message: Message; apiId: string | null } | null = null
  for (const record of activeBranch(lines)) {
    if (record['isSidechain'] === true) continue
    const createdAt = parseTimestamp(record['timestamp']) ?? header.startedAt
    const message = record['message']
    if (!isRecord(message)) continue
    if (record['type'] === 'assistant') {
      const apiId = typeof message['id'] === 'string' ? message['id'] : null
      // The CLI writes one line per content block; lines of one API response share its id.
      if (!assistant || apiId === null || assistant.apiId !== apiId) {
        assistant = {
          apiId,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: '',
            toolCalls: [],
            createdAt,
            ...(typeof message['model'] === 'string' && message['model'] !== '<synthetic>'
              ? { model: message['model'] }
              : {}),
          },
        }
        messages.push(assistant.message)
      }
      const target = assistant.message
      const blocks = Array.isArray(message['content']) ? message['content'] : []
      for (const block of blocks) {
        if (!isRecord(block)) continue
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          target.content = target.content ? `${target.content}\n\n${block['text']}` : block['text']
        } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
          target.reasoning = target.reasoning
            ? `${target.reasoning}\n\n${block['thinking']}`
            : block['thinking']
        } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
          const name = typeof block['name'] === 'string' ? block['name'] : 'tool'
          const kind = CLAUDE_TOOL_KINDS[name]
          const call: ToolCall = {
            id: block['id'],
            name,
            title: claudeToolTitle(name, block['input']),
            programmaticName: name,
            args: block['input'] ?? {},
            status: 'done',
            result: null,
            ...(kind ? { kind } : {}),
          }
          target.toolCalls.push(call)
          toolCallsById.set(call.id, call)
        }
      }
      continue
    }
    if (record['type'] !== 'user') continue
    const prompt = userPrompt(record)
    if (!prompt) continue
    assistant = null
    messages.push({
      id: randomUUID(),
      role: 'user',
      content: prompt.text,
      toolCalls: [],
      createdAt,
      ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
    })
  }
  for (const [id, call] of toolCallsById) {
    const result = results.get(id)
    if (!result) continue
    call.result = result.text
    if (result.failed) call.status = 'error'
  }
  // A response that only carried blocks Copse does not show leaves nothing to render.
  const kept = messages.filter(
    (message) =>
      message.role !== 'assistant' ||
      message.content !== '' ||
      (message.reasoning ?? '') !== '' ||
      message.toolCalls.length > 0,
  )
  if (kept.length === 0) return null
  return {
    ...header,
    messages: kept,
    updatedAt: Math.max(header.updatedAt, kept.at(-1)?.createdAt ?? 0),
  }
}
