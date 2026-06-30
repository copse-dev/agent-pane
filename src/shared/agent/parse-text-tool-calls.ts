import type { ToolCallChunk } from '@shared/types'

/** Cursor / Qwen-style tool calls embedded in assistant text instead of native tool_calls. */
const TOOL_CALL_BLOCK_RE = /<\s*tool_call\s*>([\s\S]*?)<\s*\/\s*tool_call\s*>/gi
/** A `<tool_call>` opener with no matching closer (block still streaming in). */
const OPEN_TOOL_CALL_RE = /<\s*tool_call\s*>/i
const TOOL_CALL_OPENER = '<tool_call>'
const FUNCTION_RE =
  /<\s*function\s*=\s*([^>\s]+)\s*>([\s\S]*?)(?:<\s*\/\s*function\s*>|(?=<\s*function\s*=)|(?=<\s*\/\s*tool_call\s*>))/gi
const PARAMETER_RE = /<\s*parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi

/**
 * MiniMax models (e.g. MiniMax-M3 via the Novita / Hugging Face router) wrap every
 * emitted token in this delimiter. Nothing downstream strips it, so it otherwise
 * leaks into the transcript as literal `]<]minimax[>[` garbage around the model's
 * tool-call XML. Strip it before parsing and before display. (#519)
 */
const MINIMAX_DELIMITER_RE = /\]<\]minimax\[>\[/gi
/** Anthropic / MiniMax-style `<invoke name="tool">…</invoke>` tool call embedded in text. */
const INVOKE_BLOCK_RE =
  /<\s*invoke\s+name\s*=\s*["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\s*\/\s*invoke\s*>/gi
/** An `<invoke …>` opener with no matching closer (block still streaming in). */
const OPEN_INVOKE_RE = /<\s*invoke\b/i
/** Anthropic-style parameter inside an invoke block: `<parameter name="x">value</parameter>`. */
const INVOKE_PARAM_NAMED_RE =
  /<\s*parameter\s+name\s*=\s*["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi
/** Bare child tag inside an invoke block naming a parameter: `<command>value</command>`. */
const INVOKE_PARAM_BARE_RE = /<\s*([a-zA-Z_][\w-]*)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/g

function stripMinimaxDelimiters(text: string): string {
  return text.replace(MINIMAX_DELIMITER_RE, '')
}

/**
 * Ranges of `text` that sit inside markdown code — inline spans or fenced blocks.
 * Any run of backticks opens a code region that the next equal-length run closes;
 * an unclosed run masks to the end of the text.
 *
 * Tool-call XML inside these regions is the model *documenting* tool syntax — e.g.
 * explaining this very parser with `<invoke name="tool">…</invoke>` — not invoking
 * a tool. Recovery must ignore it, otherwise the agent strips its own prose and
 * fires phantom tool calls parsed out of the documentation.
 */
function codeMaskRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const n = text.length
  let i = 0
  while (i < n) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let run = 0
    while (i + run < n && text[i + run] === '`') run++
    const fence = '`'.repeat(run)
    const close = text.indexOf(fence, i + run)
    if (close === -1) {
      ranges.push([i, n])
      break
    }
    ranges.push([i, close + run])
    i = close + run
  }
  return ranges
}

function isIndexInCode(index: number, ranges: ReadonlyArray<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
}

/** Replace regex matches that start outside any code region; leave in-code matches intact. */
function replaceOutsideCode(
  text: string,
  re: RegExp,
  ranges: ReadonlyArray<[number, number]>,
): string {
  return text.replace(re, (...args) => {
    const offset = args[args.length - 2] as number
    return isIndexInCode(offset, ranges) ? (args[0] as string) : ''
  })
}

/** First index where `re` matches outside any code region, or -1. */
function firstMatchOutsideCode(
  text: string,
  re: RegExp,
  ranges: ReadonlyArray<[number, number]>,
): number {
  const global = re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`)
  for (const match of text.matchAll(global)) {
    const idx = match.index ?? -1
    if (idx !== -1 && !isIndexInCode(idx, ranges)) return idx
  }
  return -1
}

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
  ghprlist: 'gh_pr_list',
  gh_pr_list: 'gh_pr_list',
  ghprview: 'gh_pr_view',
  gh_pr_view: 'gh_pr_view',
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

/** Parameters of an `<invoke>` block: named `<parameter name="x">` first, else bare `<x>` child tags. */
function parseInvokeParameters(body: string): Record<string, unknown> {
  const named: Record<string, unknown> = {}
  for (const match of body.matchAll(INVOKE_PARAM_NAMED_RE)) {
    const name = match[1]?.trim()
    if (!name) continue
    named[name] = (match[2] ?? '').trim()
  }
  if (Object.keys(named).length > 0) return named
  const bare: Record<string, unknown> = {}
  for (const match of body.matchAll(INVOKE_PARAM_BARE_RE)) {
    const name = match[1]?.trim()
    if (!name) continue
    bare[name] = (match[2] ?? '').trim()
  }
  return bare
}

/**
 * Parse Anthropic / MiniMax-style `<invoke name="tool">…</invoke>` blocks. MiniMax
 * emits these (often wrapped in `<tool_call>`) instead of the Cursor-style
 * `<function=…>` dialect, so the function parser finds nothing and the call leaks. (#519)
 */
function parseInvokeBlocks(
  text: string,
  coerceToolArgs?: CoerceToolArgsFn,
  codeRanges?: ReadonlyArray<[number, number]>,
): { toolCalls: ToolCallChunk[]; sawInvoke: boolean } {
  const toolCalls: ToolCallChunk[] = []
  let sawInvoke = false
  for (const match of text.matchAll(INVOKE_BLOCK_RE)) {
    // A documented `<invoke>` inside markdown code is not a real call to recover.
    if (codeRanges && isIndexInCode(match.index ?? 0, codeRanges)) continue
    sawInvoke = true
    const name = normalizeToolName(match[1] ?? '')
    if (!name) continue
    const coerced = coerceStringlyTypedToolArgs(parseInvokeParameters(match[2] ?? ''))
    const args = coerceToolArgs ? coerceToolArgs(name, coerced) : coerced
    if (coerceToolArgs && args === null) continue
    toolCalls.push({
      id: globalThis.crypto.randomUUID(),
      name,
      args: args ?? coerced,
    })
  }
  return { toolCalls, sawInvoke }
}

export interface TextToolCallRecovery {
  cleanedText: string
  toolCalls: ToolCallChunk[]
  /** When true, `<tool_call>` was present but nothing valid was extracted — keep raw XML in the transcript. */
  keptRawBlocks: boolean
}

/**
 * Index of a trailing, still-incomplete `<tool_call>` opener (e.g. `<tool_ca`
 * or a lone `<` arriving mid-stream), or -1 when the tail can't begin one.
 * Whitespace inside the opener is ignored so `< tool_call` matches `<tool_call`.
 */
function trailingPartialToolCallIndex(s: string): number {
  const lt = s.lastIndexOf('<')
  if (lt === -1) return -1
  const tail = s.slice(lt).toLowerCase().replace(/\s+/g, '')
  return tail.length < TOOL_CALL_OPENER.length && TOOL_CALL_OPENER.startsWith(tail) ? lt : -1
}

/**
 * Remove embedded pseudo tool-call blocks from assistant text (display / history).
 *
 * Complete `<tool_call>…</tool_call>` blocks are dropped. While streaming, the
 * closing tag has not arrived yet, so an unterminated opener — or even a partial
 * `<tool_ca` prefix mid-token — is held back too; otherwise the raw XML
 * (DOCTYPE, `<function=…>`, `<parameter=…>`) flashes into the transcript before
 * the block finishes. The renderer must stop emitting as soon as the tag
 * appears, not once it closes.
 */
export function stripTextToolCallBlocks(text: string): string {
  let out = stripMinimaxDelimiters(text)
  // Strip complete blocks that are real (outside code); leave documented XML in
  // backticks/fences untouched. Recompute ranges between passes since the first
  // strip shifts indices.
  out = replaceOutsideCode(out, TOOL_CALL_BLOCK_RE, codeMaskRanges(out))
  out = replaceOutsideCode(out, INVOKE_BLOCK_RE, codeMaskRanges(out))
  const ranges = codeMaskRanges(out)
  const open = firstMatchOutsideCode(out, OPEN_TOOL_CALL_RE, ranges)
  if (open !== -1) {
    out = out.slice(0, open)
  } else {
    const invokeOpen = firstMatchOutsideCode(out, OPEN_INVOKE_RE, ranges)
    if (invokeOpen !== -1) {
      out = out.slice(0, invokeOpen)
    } else {
      const partial = trailingPartialToolCallIndex(out)
      if (partial !== -1 && !isIndexInCode(partial, ranges)) out = out.slice(0, partial)
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * When the model emits Cursor-style `<tool_call>` XML — or Anthropic / MiniMax-style
 * `<invoke name="tool">…</invoke>` blocks (optionally wrapped in MiniMax `]<]minimax[>[`
 * delimiters) — in text with no native tool_calls, extract executable tool calls and
 * return prose without the XML blocks.
 */
export function recoverTextToolCalls(
  text: string,
  coerceToolArgs?: CoerceToolArgsFn,
): TextToolCallRecovery {
  // MiniMax wraps each token in a delimiter; strip it so the XML beneath is parseable. (#519)
  const normalized = stripMinimaxDelimiters(text)
  // Tool-call syntax inside markdown code is documentation, not an invocation.
  const codeRanges = codeMaskRanges(normalized)
  const toolCalls: ToolCallChunk[] = []
  let sawBlock = false
  let anyBlockUnparsed = false

  for (const match of normalized.matchAll(TOOL_CALL_BLOCK_RE)) {
    if (isIndexInCode(match.index ?? 0, codeRanges)) continue
    sawBlock = true
    const inner = match[1]
    if (!inner?.trim()) {
      anyBlockUnparsed = true
      continue
    }
    // Cursor `<function=…>` dialect first, then the Anthropic/MiniMax `<invoke>` dialect.
    let fromBlock = parseFunctionsInBlock(inner, coerceToolArgs)
    if (fromBlock.length === 0) fromBlock = parseInvokeBlocks(inner, coerceToolArgs).toolCalls
    if (fromBlock.length === 0) anyBlockUnparsed = true
    toolCalls.push(...fromBlock)
  }

  // MiniMax may emit `<invoke>` blocks without a surrounding `<tool_call>` wrapper.
  if (!sawBlock) {
    const { toolCalls: invokeCalls, sawInvoke } = parseInvokeBlocks(
      normalized,
      coerceToolArgs,
      codeRanges,
    )
    if (sawInvoke) {
      sawBlock = true
      if (invokeCalls.length === 0) anyBlockUnparsed = true
      toolCalls.push(...invokeCalls)
    }
  }

  const keptRawBlocks = sawBlock && toolCalls.length === 0 && anyBlockUnparsed

  return {
    // Even when nothing parsed, never leak the MiniMax delimiters into the transcript.
    cleanedText: keptRawBlocks ? stripMinimaxDelimiters(text) : stripTextToolCallBlocks(text),
    toolCalls,
    keptRawBlocks,
  }
}
