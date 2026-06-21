import type { ToolCallChunk } from '@shared/types'

/** Cursor / Qwen-style tool calls embedded in assistant text instead of native tool_calls. */
const TOOL_CALL_BLOCK_RE = /<\s*tool_call\s*>([\s\S]*?)<\s*\/\s*tool_call\s*>/gi
const FUNCTION_RE =
  /<\s*function\s*=\s*([^>\s]+)\s*>([\s\S]*?)(?:<\s*\/\s*function\s*>|(?=<\s*function\s*=)|(?=<\s*\/\s*tool_call\s*>))/gi
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
    args[name] = (match[2] ?? '').trim()
  }
  return args
}

/** Coerce XML text parameter values before zod validation (e.g. line numbers as strings). */
export function coerceStringlyTypedToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      out[key] = value
      continue
    }
    const t = value.trim()
    if (t === 'true') out[key] = true
    else if (t === 'false') out[key] = false
    else if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
      const n = Number(t)
      out[key] = Number.isFinite(n) ? n : value
    } else out[key] = value
  }
  return out
}

export type CoerceToolArgsFn = (
  name: string,
  args: Record<string, unknown>,
) => Record<string, unknown> | null

function parseFunctionsInBlock(inner: string, coerceToolArgs?: CoerceToolArgsFn): ToolCallChunk[] {
  const toolCalls: ToolCallChunk[] = []
  for (const match of inner.matchAll(FUNCTION_RE)) {
    const name = normalizeToolName(match[1] ?? '')
    if (!name) continue
    const coerced = coerceStringlyTypedToolArgs(parseParameters(match[2] ?? ''))
    const args = coerceToolArgs ? coerceToolArgs(name, coerced) : coerced
    if (coerceToolArgs && args === null) continue
    toolCalls.push({
      id: globalThis.crypto.randomUUID(),
      name,
      args: args ?? coerced,
    })
  }
  return toolCalls
}

export interface TextToolCallRecovery {
  cleanedText: string
  toolCalls: ToolCallChunk[]
  /** When true, `<tool_call>` was present but nothing valid was extracted — keep raw XML in the transcript. */
  keptRawBlocks: boolean
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
export function recoverTextToolCalls(
  text: string,
  coerceToolArgs?: CoerceToolArgsFn,
): TextToolCallRecovery {
  const toolCalls: ToolCallChunk[] = []
  let sawToolCallBlock = false
  let anyBlockUnparsed = false

  for (const match of text.matchAll(TOOL_CALL_BLOCK_RE)) {
    sawToolCallBlock = true
    const inner = match[1]
    if (!inner?.trim()) {
      anyBlockUnparsed = true
      continue
    }
    const fromBlock = parseFunctionsInBlock(inner, coerceToolArgs)
    if (fromBlock.length === 0) anyBlockUnparsed = true
    toolCalls.push(...fromBlock)
  }

  const keptRawBlocks = sawToolCallBlock && toolCalls.length === 0 && anyBlockUnparsed

  return {
    cleanedText: keptRawBlocks ? text : stripTextToolCallBlocks(text),
    toolCalls,
    keptRawBlocks,
  }
}
