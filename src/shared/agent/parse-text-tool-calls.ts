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
/**
 * Non-global, greedy single-block inners. Block ranges are located on a
 * code-blanked copy (so quoted examples don't mis-pair), but the inner body must
 * be sliced from the ORIGINAL text — otherwise backtick code spans inside a real
 * argument value (e.g. a `write_file` body or a `run_shell` command containing
 * inline code) are blanked to whitespace before parsing. The tags themselves
 * never contain backticks, so a greedy single-block match is exact.
 */
const TOOL_CALL_INNER_RE = /<\s*tool_call\s*>([\s\S]*)<\s*\/\s*tool_call\s*>/i
const INVOKE_INNER_RE =
  /<\s*invoke\s+name\s*=\s*["']?[^"'>\s]+["']?\s*>([\s\S]*)<\s*\/\s*invoke\s*>/i
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

/**
 * Marks every character inside an inline code span (`` `…` ``) or fenced code
 * block (```` ```…``` ````) — both are a run of N backticks closed by another run
 * of N. A `<tool_call>` / `<invoke>` quoted inside code is the model *describing*
 * the delimiter syntax (e.g. when reviewing this very parser), not a real call.
 * Detection must skip these: otherwise stripping freezes the transcript at the
 * quoted opener — waiting for a closing tag that, being prose, never arrives —
 * and recovery turns the example into a phantom tool call.
 */
function codeSpanMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length)
  const n = text.length
  let i = 0
  while (i < n) {
    if (text[i] !== '`') {
      i += 1
      continue
    }
    const runStart = i
    while (i < n && text[i] === '`') i += 1
    const runLen = i - runStart
    let j = i
    let closed = false
    while (j < n) {
      if (text[j] !== '`') {
        j += 1
        continue
      }
      const closeStart = j
      while (j < n && text[j] === '`') j += 1
      if (j - closeStart === runLen) {
        for (let p = runStart; p < j; p += 1) mask[p] = 1
        closed = true
        break
      }
    }
    // An unterminated backtick run is literal text, not code — leave it unmasked.
    i = closed ? j : runStart + runLen
  }
  return mask
}

/**
 * A copy of `text` with every code-span character replaced by a space, so quoted
 * tool-call syntax is invisible to the delimiter regexes while indices and length
 * stay aligned with the original (for slicing / inner extraction). Blanking rather
 * than per-match filtering matters because a lazy `<tool_call>…</tool_call>` regex
 * would otherwise pair a quoted opener with a *later* real block's closer.
 */
function blankCodeSpans(text: string): string {
  const mask = codeSpanMask(text)
  const chars = text.split('')
  for (let i = 0; i < chars.length; i += 1) if (mask[i] === 1) chars[i] = ' '
  return chars.join('')
}

/** Drop complete `re` blocks that sit outside code spans; quoted examples stay. */
function removeBlocksOutsideCode(text: string, re: RegExp): string {
  const blanked = blankCodeSpans(text)
  const ranges: Array<[number, number]> = []
  for (const match of blanked.matchAll(re)) {
    ranges.push([match.index, match.index + match[0].length])
  }
  let out = text
  for (let k = ranges.length - 1; k >= 0; k -= 1) {
    const range = ranges[k]
    if (!range) continue
    out = out.slice(0, range[0]) + out.slice(range[1])
  }
  return out
}

/**
 * Slice one block's inner text from `original` at the offsets of a match found on
 * the blanked copy (identical indices/length), preserving code-span content. Falls
 * back to `null` if the wrapper can't be re-matched in the slice.
 */
function sliceOriginalInner(
  original: string,
  start: number,
  length: number,
  innerRe: RegExp,
): string | null {
  const block = original.slice(start, start + length)
  const m = innerRe.exec(block)
  return m ? (m[1] ?? '') : null
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
  // Where to slice each block's inner body from. When `text` is a code-blanked
  // copy, pass the original here so argument values keep their backtick spans.
  contentText: string = text,
): { toolCalls: ToolCallChunk[]; sawInvoke: boolean } {
  const toolCalls: ToolCallChunk[] = []
  let sawInvoke = false
  for (const match of text.matchAll(INVOKE_BLOCK_RE)) {
    sawInvoke = true
    const name = normalizeToolName(match[1] ?? '')
    if (!name) continue
    const body =
      sliceOriginalInner(contentText, match.index, match[0].length, INVOKE_INNER_RE) ??
      match[2] ??
      ''
    const coerced = coerceStringlyTypedToolArgs(parseInvokeParameters(body))
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
  out = removeBlocksOutsideCode(out, TOOL_CALL_BLOCK_RE)
  out = removeBlocksOutsideCode(out, INVOKE_BLOCK_RE)
  // Search on a code-blanked copy so a quoted `<tool_call>` / `<invoke>` example
  // is not mistaken for a streaming opener that freezes the rest of the message.
  const blanked = blankCodeSpans(out)
  const open = blanked.search(OPEN_TOOL_CALL_RE)
  if (open !== -1) {
    out = out.slice(0, open)
  } else {
    const invokeOpen = blanked.search(OPEN_INVOKE_RE)
    if (invokeOpen !== -1) {
      out = out.slice(0, invokeOpen)
    } else {
      const partial = trailingPartialToolCallIndex(blanked)
      if (partial !== -1) out = out.slice(0, partial)
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
  // Match on a code-blanked copy so quoted `<tool_call>` / `<invoke>` examples are
  // not extracted as phantom calls. Real blocks contain no code spans, so their
  // captured inner text is identical in the blanked copy.
  const blanked = blankCodeSpans(normalized)
  const toolCalls: ToolCallChunk[] = []
  let sawBlock = false
  let anyBlockUnparsed = false

  for (const match of blanked.matchAll(TOOL_CALL_BLOCK_RE)) {
    sawBlock = true
    // Slice the inner from the original (not the blanked copy) so argument values
    // containing backtick code spans survive; the blanked copy is only for
    // locating the block range. (#519 arg corruption)
    const inner = sliceOriginalInner(normalized, match.index, match[0].length, TOOL_CALL_INNER_RE)
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
    // Detect on the blanked copy, but slice inner bodies from the original.
    const { toolCalls: invokeCalls, sawInvoke } = parseInvokeBlocks(
      blanked,
      coerceToolArgs,
      normalized,
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
