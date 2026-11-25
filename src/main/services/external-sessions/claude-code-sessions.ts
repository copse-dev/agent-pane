import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Message, ToolCall } from '@shared/types'
import { isRecord } from '@shared/unknown-value.ts'
import { capToolResult, oneLineTitle, parseTimestamp, readJsonlRecords } from './session-files.ts'
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
  } = { cwd: null, gitBranch: null, startedAt: null, title: null, summary: null }
  await readJsonlRecords(
    file.path,
    (line) => {
      if (line['type'] === 'summary' && typeof line['summary'] === 'string') {
        found.summary ??= line['summary']
        return
      }
      if (line['isSidechain'] === true) return
      found.cwd ??= stringField(line, 'cwd')
      found.gitBranch ??= stringField(line, 'gitBranch')
      found.startedAt ??= parseTimestamp(line['timestamp'])
      if (found.title === null && line['type'] === 'user') {
        const prompt = userPrompt(line)
        if (prompt?.text) found.title = prompt.text
      }
      return found.cwd === null || found.title === null
    },
    { maxBytes: HEADER_SCAN_BYTES },
  )
  const { cwd, gitBranch, startedAt, title, summary } = found
  if (cwd === null || (title === null && summary === null)) return null
  return {
    source: 'claude-code',
    sessionId: basename(file.path, '.jsonl'),
    cwd,
    ...(gitBranch ? { gitBranch } : {}),
    title: oneLineTitle(summary ?? title ?? ''),
    startedAt: startedAt ?? file.updatedAt,
    updatedAt: file.updatedAt,
    messages: [],
  }
}

interface ClaudeLine {
  record: Record<string, unknown>
  uuid: string | null
  parent: string | null
}

/**
 * The conversation on the session's active branch, oldest first: walk back
 * from the last conversation line through `parentUuid`, crossing compaction
 * boundaries through `logicalParentUuid`.
 */
function activeBranch(lines: ClaudeLine[]): Record<string, unknown>[] {
  const byUuid = new Map<string, ClaudeLine>()
  for (const line of lines) if (line.uuid) byUuid.set(line.uuid, line)
  const leaf = lines.findLast(
    (line) =>
      (line.record['type'] === 'user' || line.record['type'] === 'assistant') &&
      line.record['isSidechain'] !== true,
  )
  // Without links (very old files), file order is the conversation order.
  if (!leaf?.uuid) return lines.map((line) => line.record)
  const branch: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let current: ClaudeLine | undefined = leaf
  while (current && current.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid)
    branch.push(current.record)
    current = current.parent ? byUuid.get(current.parent) : undefined
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

const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024

/** The user's own words (and pasted images) on a `user` line, or `null` for tool results. */
function userPrompt(record: Record<string, unknown>): { text: string; images: string[] } | null {
  if (record['isMeta'] === true || record['isCompactSummary'] === true) return null
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
    .map((text) => slashCommand(text) ?? (isCliNoise(text) ? '' : text))
    .filter((text) => text.trim())
    .join('\n\n')
  if (!words && images.length === 0) return null
  return { text: words, images }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
        ? [block['text']]
        : [],
    )
    .join('\n')
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
  await readJsonlRecords(file.path, (record) => {
    const type = record['type']
    if (type !== 'user' && type !== 'assistant' && type !== 'system') return
    lines.push({
      record,
      uuid: stringField(record, 'uuid'),
      parent: stringField(record, 'parentUuid') ?? stringField(record, 'logicalParentUuid'),
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
    const content = message['content']
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || block['type'] !== 'tool_result') continue
        const id = block['tool_use_id']
        const call = typeof id === 'string' ? toolCallsById.get(id) : undefined
        if (!call) continue
        call.result = capToolResult(toolResultText(block['content']))
        if (block['is_error'] === true) call.status = 'error'
      }
    }
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
  // A response that only carried blocks Copse does not show leaves nothing to render.
  const kept = messages.filter(
    (message) =>
      message.role !== 'assistant' ||
      message.content !== '' ||
      (message.reasoning ?? '') !== '' ||
      message.toolCalls.length > 0,
  )
  if (!kept.some((message) => message.role === 'user')) return null
  return {
    ...header,
    messages: kept,
    updatedAt: Math.max(header.updatedAt, kept.at(-1)?.createdAt ?? 0),
  }
}
