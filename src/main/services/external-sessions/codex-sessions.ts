import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Message, ToolCall } from '@shared/types'
import { safeJsonParse } from '@shared/safe-json.ts'
import { isRecord } from '@shared/unknown-value.ts'
import {
  capToolResult,
  oneLineTitle,
  parseTimestamp,
  readJsonlRecords,
  withoutHarnessText,
} from './session-files.ts'
import type { ExternalSessionFile, ParsedExternalSession } from './external-session-types.ts'

/**
 * The Codex CLI's saved sessions ("rollouts"): one JSONL file per session under
 * `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, where `<home>` is
 * `$CODEX_HOME` or `~/.codex`. The first line is the session's metadata; later
 * lines are `{ timestamp, type, payload }` records, of which `response_item`
 * carries the Responses API items (messages, reasoning, tool calls and their
 * output). Older files wrote the item itself on each line, without the wrapper.
 */

export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['CODEX_HOME']
  return configured && configured.trim() ? configured : join(homedir(), '.codex')
}

/** Newest first; a scan never reads more headers than this. */
const MAX_ROLLOUT_FILES = 1000
const HEADER_SCAN_BYTES = 2 * 1024 * 1024

export async function listCodexSessionFiles(
  home = codexHomeDir(),
): Promise<ExternalSessionFile[] | null> {
  const sessionsDir = join(home, 'sessions')
  const top = await readdir(sessionsDir, { withFileTypes: true }).catch(() => null)
  if (!top) return null
  const paths: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1)
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'))
        paths.push(path)
    }
  }
  await walk(sessionsDir, 0)
  // Names start with the session's start time, so this is newest first.
  paths.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const files: ExternalSessionFile[] = []
  for (const path of paths.slice(0, MAX_ROLLOUT_FILES)) {
    const info = await stat(path).catch(() => null)
    if (info) files.push({ source: 'codex', path, updatedAt: info.mtimeMs, bytes: info.size })
  }
  return files
}

/** A rollout line's Responses API item, from either file layout. */
function rolloutItem(line: Record<string, unknown>): Record<string, unknown> | null {
  if (line['type'] === 'response_item') return isRecord(line['payload']) ? line['payload'] : null
  // Pre-wrapper rollouts wrote items directly.
  if (!Object.hasOwn(line, 'payload') && typeof line['type'] === 'string') return line
  return null
}

function sessionMeta(line: Record<string, unknown>): Record<string, unknown> | null {
  if (line['type'] === 'session_meta') return isRecord(line['payload']) ? line['payload'] : null
  // Pre-wrapper rollouts opened with `{ id, timestamp, instructions }`.
  if (typeof line['id'] === 'string' && !Object.hasOwn(line, 'type')) return line
  return null
}

function contentText(content: unknown, separator = '\n\n'): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) =>
      isRecord(part) && typeof part['text'] === 'string' && part['text'] ? [part['text']] : [],
    )
    .join(separator)
}

/**
 * Context Codex sends as a user message but the user never typed: the
 * environment block, AGENTS.md instructions, and similar wrappers.
 */
function isInjectedUserText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith('# AGENTS.md instructions')) return true
  const tag = /^<([a-z_][a-z0-9_ -]*)>/i.exec(trimmed)?.[1]
  return tag !== undefined && trimmed.endsWith(`</${tag}>`)
}

/**
 * How a prompt Copse itself sent through the Codex agent begins (the session
 * notes or the bridge identity, built in `buildAcpPrompt`). Such sessions are
 * already Copse threads, so they are not offered for import.
 */
const COPSE_PROMPT_OPENINGS = [
  'Session notes: this session persists across turns',
  'Copse native bridge for this turn:',
  'You are continuing an existing Copse chat.',
]

export function isCopsePrompt(text: string): boolean {
  const trimmed = text.trimStart()
  return COPSE_PROMPT_OPENINGS.some((opening) => trimmed.startsWith(opening))
}

/**
 * A session Codex started on its own behalf (a reviewer or other subagent),
 * not one the user ran.
 */
function isSubagentSession(meta: Record<string, unknown>): boolean {
  const source = meta['source']
  if (isRecord(source) && Object.hasOwn(source, 'subagent')) return true
  if (typeof meta['parent_thread_id'] === 'string') return true
  const threadSource = meta['thread_source']
  return typeof threadSource === 'string' && threadSource.includes('review')
}

function userText(item: Record<string, unknown>): string | null {
  if (item['type'] !== 'message' || item['role'] !== 'user') return null
  const text = contentText(item['content'])
  if (isInjectedUserText(text)) return null
  const typed = withoutHarnessText(text)
  return typed ? typed : null
}

export async function readCodexSessionHeader(
  file: ExternalSessionFile,
): Promise<ParsedExternalSession | null> {
  const found: { meta: Record<string, unknown> | null; title: string | null } = {
    meta: null,
    title: null,
  }
  await readJsonlRecords(
    file.path,
    (line) => {
      found.meta ??= sessionMeta(line)
      const item = rolloutItem(line)
      if (item && found.title === null) found.title = userText(item)
      return found.meta === null || found.title === null
    },
    { maxBytes: HEADER_SCAN_BYTES },
  )
  const { meta: header, title } = found
  if (!header || title === null) return null
  if (isSubagentSession(header) || isCopsePrompt(title)) return null
  const sessionId = header['id']
  const cwd = header['cwd']
  if (typeof sessionId !== 'string' || typeof cwd !== 'string') return null
  const git = isRecord(header['git']) ? header['git'] : null
  const branch = git && typeof git['branch'] === 'string' && git['branch'] ? git['branch'] : null
  return {
    source: 'codex',
    sessionId,
    cwd,
    ...(branch ? { gitBranch: branch } : {}),
    title: oneLineTitle(title),
    startedAt: parseTimestamp(header['timestamp']) ?? file.updatedAt,
    updatedAt: file.updatedAt,
    messages: [],
  }
}

/** A shell call's command line, from `["bash", "-lc", "…"]` or a plain string. */
function commandLine(command: unknown): string | null {
  if (typeof command === 'string') return command
  if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) return null
  const parts = command.filter((part) => typeof part === 'string')
  if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0] ?? '') && parts[1]?.startsWith('-'))
    return parts[2] ?? null
  return parts.join(' ')
}

const SHELL_TOOLS = new Set(['shell', 'container.exec', 'exec_command', 'local_shell'])

function toolCall(
  id: string,
  name: string,
  args: unknown,
): Pick<ToolCall, 'id' | 'name' | 'title' | 'programmaticName' | 'args' | 'kind'> {
  const command = isRecord(args) ? commandLine(args['command'] ?? args['cmd']) : null
  if (SHELL_TOOLS.has(name) && command)
    return {
      id,
      name,
      title: oneLineTitle(command, 120),
      programmaticName: name,
      args,
      kind: 'execute',
    }
  // Newer Codex runs commands as `exec` (a script, as the raw input) and polls a
  // running one with `wait`.
  if (name === 'exec' && typeof args === 'string' && args.trim())
    return {
      id,
      name,
      title: oneLineTitle(args.trim().split('\n')[0] ?? name, 120),
      programmaticName: name,
      args,
      kind: 'execute',
    }
  if (name === 'wait' && isRecord(args) && typeof args['cell_id'] === 'string')
    return {
      id,
      name,
      title: `Wait for cell ${args['cell_id']}`,
      programmaticName: name,
      args,
      kind: 'execute',
    }
  if (name === 'apply_patch')
    return { id, name, title: 'Apply patch', programmaticName: name, args, kind: 'edit' }
  return { id, name, title: name, programmaticName: name, args }
}

/** Output parts: text runs end in their own newlines; images become a marker. */
function outputPartsText(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (!isRecord(part)) return ''
      if (typeof part['text'] === 'string') return part['text']
      return part['type'] === 'input_image' ? '[image]\n' : ''
    })
    .join('')
}

/**
 * Function-call output: a string, the JSON `{ output, metadata: { exit_code } }`
 * form, or (newer Codex) an array of `{ type: 'input_text', text }` parts.
 */
function callOutput(output: unknown): { text: string; failed: boolean } {
  const raw = isRecord(output) ? output['content'] : output
  if (Array.isArray(raw)) return { text: outputPartsText(raw), failed: false }
  if (typeof raw !== 'string') return { text: '', failed: false }
  const parsed = safeJsonParse(raw)
  if (isRecord(parsed) && typeof parsed['output'] === 'string') {
    const metadata = isRecord(parsed['metadata']) ? parsed['metadata'] : null
    const exit = metadata?.['exit_code']
    return { text: parsed['output'], failed: typeof exit === 'number' && exit !== 0 }
  }
  return { text: raw, failed: false }
}

export async function readCodexSession(
  file: ExternalSessionFile,
): Promise<ParsedExternalSession | null> {
  const header = await readCodexSessionHeader(file)
  if (!header) return null
  const messages: Message[] = []
  const calls = new Map<string, ToolCall>()
  let assistant: Message | null = null
  const openAssistant = (createdAt: number, fresh: boolean): Message => {
    if (assistant && !fresh) return assistant
    assistant = { id: randomUUID(), role: 'assistant', content: '', toolCalls: [], createdAt }
    messages.push(assistant)
    return assistant
  }
  await readJsonlRecords(file.path, (line) => {
    const item = rolloutItem(line)
    if (!item) return
    const createdAt = parseTimestamp(line['timestamp']) ?? header.startedAt
    const current: Message | null = assistant
    switch (item['type']) {
      case 'message': {
        if (item['role'] === 'user') {
          const text = userText(item)
          if (text === null) return
          assistant = null
          messages.push({ id: randomUUID(), role: 'user', content: text, toolCalls: [], createdAt })
          return
        }
        if (item['role'] !== 'assistant') return
        const text = contentText(item['content'])
        if (!text) return
        // Prose after tool calls starts the next step, as it does in a live Copse turn.
        const target = openAssistant(
          createdAt,
          current === null || current.toolCalls.length > 0 || current.content !== '',
        )
        target.content = text
        return
      }
      case 'reasoning': {
        const summary = Array.isArray(item['summary']) ? contentText(item['summary']) : ''
        if (!summary) return
        const target = openAssistant(
          createdAt,
          current === null || current.toolCalls.length > 0 || current.content !== '',
        )
        target.reasoning = target.reasoning ? `${target.reasoning}\n\n${summary}` : summary
        return
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const id = item['call_id'] ?? item['id']
        if (typeof id !== 'string') return
        const name =
          item['type'] === 'local_shell_call'
            ? 'local_shell'
            : typeof item['name'] === 'string'
              ? item['name']
              : 'tool'
        const args =
          item['type'] === 'function_call' && typeof item['arguments'] === 'string'
            ? (safeJsonParse(item['arguments']) ?? item['arguments'])
            : item['type'] === 'local_shell_call'
              ? item['action']
              : item['input']
        const call: ToolCall = {
          ...toolCall(id, name, args),
          status: 'done',
          result: null,
        }
        openAssistant(createdAt, false).toolCalls.push(call)
        calls.set(id, call)
        return
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const id = item['call_id']
        const call = typeof id === 'string' ? calls.get(id) : undefined
        if (!call) return
        const { text, failed } = callOutput(item['output'])
        call.result = capToolResult(text)
        if (failed) call.status = 'error'
        return
      }
      default:
        return
    }
  })
  if (!messages.some((message) => message.role === 'user')) return null
  return {
    ...header,
    messages,
    updatedAt: Math.max(header.updatedAt, messages.at(-1)?.createdAt ?? 0),
  }
}
