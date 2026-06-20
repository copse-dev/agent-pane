import type { ToolCallChunk } from '@shared/types'

/** Cursor / Qwen-style tool calls embedded in assistant text instead of native tool_calls. */
const TOOL_CALL_BLOCK_RE = /<\s*tool_call\s*>([\s\S]*?)<\s*\/\s*tool_call\s*>/gi
const FUNCTION_RE =
  /<\s*function\s*=\s*([^>\s]+)\s*>([\s\S]*?)(?:<\s*\/\s*function\s*>|(?=<\s*\/\s*tool_call\s*>))/i
const PARAMETER_RE = /<\s*parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi

const TOOL_NAME_ALIASES: Record<string, string> = {
  runshell: 'run_shell',
  run_shell: 'run_shell',
  readfile: 'read_file',
  read_file: 'read_file',
  listdir: 'list_dir',
  list_dir: 'list_dir',
  searchcode: 'search_code',
  search_code: 'search_code',
  searchcodebase: 'search_codebase',
  search_codebase: 'search_codebase',
  findfiles: 'find_files',
  find_files: 'find_files',
  writefile: 'write_file',
  write_file: 'write_file',
  strreplace: 'str_replace',
  str_replace: 'str_replace',
  gitstatus: 'git_status',
  git_status: 'git_status',
  gitdiff: 'git_diff',
  git_diff: 'git_diff',
  gitlog: 'git_log',
  git_log: 'git_log',
  explore: 'explore',
}

function normalizeToolName(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/-/g, '_')
  return TOOL_NAME_ALIASES[key] ?? raw.trim()
}

function parseParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const match of body.matchAll(PARAMETER_RE)) {
    const name = match[1]?.trim()
    if (!name) continue
    const value = (match[2] ?? '').trim()
    if (name === 'timeout_ms') {
      const n = Number(value)
      if (Number.isFinite(n)) args[name] = n
    } else {
      args[name] = value
    }
  }
  return args
}

function parseSingleBlock(inner: string): ToolCallChunk | null {
  const fnMatch = FUNCTION_RE.exec(inner)
  if (!fnMatch) return null
  const name = normalizeToolName(fnMatch[1] ?? '')
  if (!name) return null
  const args = parseParameters(fnMatch[2] ?? '')
  return {
    id: globalThis.crypto.randomUUID(),
    name,
    args,
  }
}

export interface TextToolCallRecovery {
  cleanedText: string
  toolCalls: ToolCallChunk[]
}

/** Remove embedded pseudo tool-call blocks from assistant text (display / history). */
export function stripTextToolCallBlocks(text: string): string {
  return text
    .replace(TOOL_CALL_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/**
 * When the model emits Cursor-style `<tool_call>` XML in text with no native tool_calls,
 * extract executable tool calls and return prose without the XML blocks.
 */
export function recoverTextToolCalls(text: string): TextToolCallRecovery {
  const toolCalls: ToolCallChunk[] = []
  for (const match of text.matchAll(TOOL_CALL_BLOCK_RE)) {
    const inner = match[1]
    if (!inner) continue
    const tc = parseSingleBlock(inner)
    if (tc) toolCalls.push(tc)
  }
  return {
    cleanedText: stripTextToolCallBlocks(text),
    toolCalls,
  }
}
