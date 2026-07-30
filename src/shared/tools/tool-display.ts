import type { ToolCall } from '@shared/types'
import { isRecord } from '@shared/unknown-value.ts'

/** Progressive while a tool is in flight; past once it settles (done/error). */
export type ToolLabelTense = 'running' | 'done'

interface DualLabel {
  running: string
  done: string
}

function pickLabel(label: DualLabel | string, tense: ToolLabelTense): string {
  return typeof label === 'string' ? label : label[tense]
}

function tenseFromStatus(status: ToolCall['status']): ToolLabelTense {
  return status === 'running' ? 'running' : 'done'
}

const TOOL_DISPLAY_NAMES: Record<string, DualLabel | string> = {
  explore: { running: 'Exploring files', done: 'Explored files' },
  read_file: { running: 'Reading file', done: 'Read file' },
  list_dir: { running: 'Listing directory', done: 'Listed directory' },
  search_code: { running: 'Searching code', done: 'Searched code' },
  search_codebase: { running: 'Searching codebase', done: 'Searched codebase' },
  semantic_search: { running: 'Searching codebase', done: 'Searched codebase' },
  find_files: { running: 'Finding files', done: 'Found files' },
  web_search: { running: 'Searching the web', done: 'Searched the web' },
  fetch_url: { running: 'Fetching page', done: 'Fetched page' },
  browser_navigate: { running: 'Opening browser', done: 'Opened browser' },
  browser_snapshot: { running: 'Taking page snapshot', done: 'Took page snapshot' },
  browser_screenshot: { running: 'Taking screenshot', done: 'Took screenshot' },
  browser_click: { running: 'Clicking element', done: 'Clicked element' },
  browser_type: { running: 'Typing text', done: 'Typed text' },
  browser_tabs: { running: 'Listing browser tabs', done: 'Listed browser tabs' },
  git_status: { running: 'Checking git status', done: 'Checked git status' },
  git_diff: { running: 'Viewing git diff', done: 'Viewed git diff' },
  git_log: { running: 'Viewing git log', done: 'Viewed git log' },
  git_show: { running: 'Viewing git commit', done: 'Viewed git commit' },
  gh_pr_list: { running: 'Listing pull requests', done: 'Listed pull requests' },
  gh_pr_view: { running: 'Viewing pull request', done: 'Viewed pull request' },
  gh_run_list: { running: 'Listing CI runs', done: 'Listed CI runs' },
  gh_run_view: { running: 'Viewing CI run logs', done: 'Viewed CI run logs' },
  investigate_ci: { running: 'Investigating CI', done: 'Investigated CI' },
  delegate_step: { running: 'Delegating step', done: 'Delegated step' },
  get_ci_status: { running: 'Checking CI status', done: 'Checked CI status' },
  wait_for_ci_checks: { running: 'Waiting for CI', done: 'Waited for CI' },
  get_ci_failure_logs: { running: 'Fetching CI failure logs', done: 'Fetched CI failure logs' },
  write_file: { running: 'Writing file', done: 'Wrote file' },
  str_replace: { running: 'Replacing in file', done: 'Replaced in file' },
  delete_file: { running: 'Deleting file', done: 'Deleted file' },
  rename_file: { running: 'Renaming file', done: 'Renamed file' },
  make_directory: { running: 'Creating directory', done: 'Created directory' },
  run_shell: { running: 'Running command', done: 'Ran command' },
  run_background: { running: 'Starting background task', done: 'Started background task' },
  read_terminal: { running: 'Reading shell', done: 'Read shell' },
  video_frames: { running: 'Reading video', done: 'Read video' },
  ask_user: { running: 'Asking user', done: 'Asked user' },
  update_todos: { running: 'Updating plan', done: 'Updated plan' },
  run_checkup: { running: 'Running checkup', done: 'Ran checkup' },
}

interface ToolGroupDef {
  tools: string[]
  label: DualLabel
}

const TOOL_GROUPS: Record<string, ToolGroupDef> = {
  reading: {
    tools: ['explore', 'read_file', 'list_dir', 'video_frames'],
    label: { running: 'Reading files', done: 'Read files' },
  },
  searching: {
    tools: ['search_code', 'search_codebase', 'semantic_search', 'find_files'],
    label: { running: 'Searching', done: 'Searched' },
  },
  web: {
    tools: ['web_search', 'fetch_url'],
    label: { running: 'Fetching from web', done: 'Fetched from web' },
  },
  browser: {
    tools: [
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_tabs',
    ],
    label: { running: 'Using browser', done: 'Used browser' },
  },
  git: {
    tools: [
      'git_status',
      'git_diff',
      'git_log',
      'git_show',
      'gh_pr_list',
      'gh_pr_view',
      'gh_run_list',
      'gh_run_view',
      'get_ci_status',
      'wait_for_ci_checks',
      'get_ci_failure_logs',
    ],
    label: { running: 'Checking git', done: 'Checked git' },
  },
  writing: {
    tools: ['write_file', 'str_replace', 'delete_file', 'rename_file', 'make_directory'],
    label: { running: 'Editing files', done: 'Edited files' },
  },
  shell: {
    tools: ['run_shell', 'run_background', 'read_terminal'],
    label: { running: 'Running commands', done: 'Ran commands' },
  },
}

const TOOL_TO_GROUP = new Map<string, string>(
  Object.entries(TOOL_GROUPS).flatMap(([key, { tools }]) => tools.map((name) => [name, key])),
)

// External ACP agents don't use the built-in tool names, but they do tag each
// call with a coarse ACP `kind`. Mapping the kind onto the same group keys lets
// their cards collapse and read like the native ones (e.g. a run of reads →
// "Read files"). `'other'`/`'think'` stay ungrouped (they never reach here —
// the adapter only carries meaningful kinds).
const ACP_KIND_TO_GROUP: Record<string, string> = {
  execute: 'shell',
  read: 'reading',
  edit: 'writing',
  delete: 'writing',
  move: 'writing',
  search: 'searching',
  fetch: 'web',
}

export type ToolCallDisplayItem =
  | {
      type: 'rollup'
      key: string
      label: string
      children: ToolCallDisplayItem[]
      toolCalls: ToolCall[]
    }
  | { type: 'group'; key: string; label: string; toolCalls: ToolCall[] }
  | { type: 'individual'; toolCall: ToolCall; label: string }

const MCP_PREFIX = 'mcp__'
const MCP_GROUP_PREFIX = 'mcp:'
const TURN_ROLLUP_KEY = 'turn'

interface ParsedMcp {
  server: string
  tool: string
}

function parseMcp(name: string): ParsedMcp | null {
  if (!name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep < 0) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/** Human label for a tool name. Defaults to past/settled tense. */
export function getToolDisplayName(name: string, tense: ToolLabelTense = 'done'): string {
  const known = TOOL_DISPLAY_NAMES[name]
  if (known) return pickLabel(known, tense)
  const mcp = parseMcp(name)
  if (mcp) return formatToolNameFallback(mcp.tool)
  // Strip known MCP/ACP server prefixes (dot or underscore notation) so the
  // user sees just the tool name, not the internal server alias.
  const stripped = name.replace(/^(?:Mcp\.[^.]+\.|mcp__[^_]+__)/i, '')
  if (stripped !== name) return formatToolNameFallback(stripped)
  return formatToolNameFallback(name)
}

function stringArg(args: unknown, key: string): string | null {
  if (!isRecord(args)) return null
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function fileEditPath(args: unknown): string | null {
  return stringArg(args, 'path')
}

// File-edit tools surface a workspace-relative path so the card can deep-link to
// the file's diff. `rename_file` keys its source on `from` instead of `path`.
const FILE_EDIT_PATH_ARG: Record<string, string> = {
  write_file: 'path',
  str_replace: 'path',
  delete_file: 'path',
  rename_file: 'from',
  make_directory: 'path',
}

/** Workspace-relative path a file-edit tool touched, or null for non-edit tools. */
export function getToolEditPath(tc: ToolCall): string | null {
  const key = FILE_EDIT_PATH_ARG[tc.name]
  if (!key) return null
  return stringArg(tc.args, key)
}

// Commands are almost always prefixed with `cd <workspace> && ` so the agent
// runs from the project root. That prefix is noise in the UI — strip a single
// leading `cd <path> && ` (quoted or bare path).
const SHELL_CD_PREFIX_RE = /^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s&|;]+)\s*&&\s*/

export function stripShellCdPrefix(command: string): string {
  return command.replace(SHELL_CD_PREFIX_RE, '')
}

const SHELL_LABEL_MAX = 96

/** A compact, single-line command for a tool header: cd-prefix stripped, collapsed, capped. */
export function shellCommandLabel(command: string): string {
  const cleaned = stripShellCdPrefix(command).replace(/\s+/g, ' ').trim()
  if (cleaned.length <= SHELL_LABEL_MAX) return cleaned
  return `${cleaned.slice(0, SHELL_LABEL_MAX - 1)}…`
}

function shellCommandArg(args: unknown): string | null {
  if (!isRecord(args)) return null
  const command = args['command']
  return typeof command === 'string' && command.trim() ? command : null
}

/** The cd-stripped command strings for any run_shell tool calls in `toolCalls`. */
export function shellCommandsFromToolCalls(toolCalls: ToolCall[]): string[] {
  const commands: string[] = []
  for (const tc of toolCalls) {
    if (tc.name !== 'run_shell' || tc.status === 'error') continue
    const command = shellCommandArg(tc.args)
    if (command) commands.push(stripShellCdPrefix(command).trim())
  }
  return commands
}

/**
 * Human label for a tool card — file edits show `Edited <path>` (or progressive
 * while running) and shell commands surface the actual (cd-stripped) command
 * instead of a generic name, so the user can see what ran without expanding.
 */
export function getToolCallLabel(tc: ToolCall): string {
  const tense = tenseFromStatus(tc.status)
  if (tc.name === 'write_file' || tc.name === 'str_replace') {
    const path = fileEditPath(tc.args)
    if (path) return tense === 'running' ? `Editing ${path}` : `Edited ${path}`
  }
  if (tc.name === 'delete_file') {
    const path = fileEditPath(tc.args)
    if (path) return tense === 'running' ? `Deleting ${path}` : `Deleted ${path}`
  }
  if (tc.name === 'rename_file') {
    const from = stringArg(tc.args, 'from')
    const to = stringArg(tc.args, 'to')
    if (from && to) {
      return tense === 'running' ? `Renaming ${from} → ${to}` : `Renamed ${from} → ${to}`
    }
  }
  if (tc.name === 'make_directory') {
    const path = fileEditPath(tc.args)
    if (path) {
      return tense === 'running' ? `Creating directory ${path}` : `Created directory ${path}`
    }
  }
  if (tc.name === 'run_shell' || tc.kind === 'execute') {
    // ACP shells (`kind: 'execute'`) may carry the command in `rawInput`; when
    // they don't, the ACP title (the tool's `name`) is already the command.
    // Commands are tenseless — the same string works while running and after.
    const command = shellCommandArg(tc.args)
    if (command) return shellCommandLabel(command)
  }
  return getToolDisplayName(tc.name, tense)
}

export function getToolGroupKey(name: string, kind?: string): string | null {
  const builtIn = TOOL_TO_GROUP.get(name)
  if (builtIn) return builtIn
  const mcp = parseMcp(name)
  if (mcp) {
    // Copse exposes its built-in tools through MCP to some agent clients. Keep
    // those wrappers in the same semantic groups as their bare counterparts.
    if (mcp.server === 'copse') {
      const copseBuiltIn = TOOL_TO_GROUP.get(mcp.tool)
      if (copseBuiltIn) return copseBuiltIn
    }
    if (mcp.server === 'copse.git') return 'git'
    if (mcp.server === 'copse.run') return 'shell'
    return `${MCP_GROUP_PREFIX}${mcp.server}`
  }
  if (kind && ACP_KIND_TO_GROUP[kind]) return ACP_KIND_TO_GROUP[kind]
  return null
}

export function getToolGroupLabel(key: string, tense: ToolLabelTense = 'done'): string {
  if (key.startsWith(MCP_GROUP_PREFIX)) {
    return key.slice(MCP_GROUP_PREFIX.length)
  }
  const group = TOOL_GROUPS[key]
  if (!group) return key
  return pickLabel(group.label, tense)
}

function formatToolNameFallback(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function aggregateToolStatus(toolCalls: ToolCall[]): ToolCall['status'] {
  if (toolCalls.some((tc) => tc.status === 'running')) return 'running'
  if (toolCalls.some((tc) => tc.status === 'error')) return 'error'
  return 'done'
}

// Successful and failed calls aggregate into separate cards so a batch of
// identical failures collapses into one error group rather than spamming the
// timeline with indistinguishable rows. The suffix keeps the two buckets'
// group keys (and thus their DOM ids / expansion state) distinct.
const ERROR_BUCKET_SUFFIX = '::errors'

function bucketKey(groupKey: string, isError: boolean): string {
  return isError ? `${groupKey}${ERROR_BUCKET_SUFFIX}` : groupKey
}

function buildGroupedDisplayItems(toolCalls: ToolCall[]): ToolCallDisplayItem[] {
  if (toolCalls.length === 0) return []

  const groupMembers = new Map<string, ToolCall[]>()
  for (const tc of toolCalls) {
    const groupKey = getToolGroupKey(tc.name, tc.kind)
    if (!groupKey) continue
    const key = bucketKey(groupKey, tc.status === 'error')
    const members = groupMembers.get(key) ?? []
    members.push(tc)
    groupMembers.set(key, members)
  }

  const result: ToolCallDisplayItem[] = []
  const emittedGroups = new Set<string>()

  for (const tc of toolCalls) {
    const groupKey = getToolGroupKey(tc.name, tc.kind)
    if (!groupKey) {
      result.push({ type: 'individual', toolCall: tc, label: getToolCallLabel(tc) })
      continue
    }

    const key = bucketKey(groupKey, tc.status === 'error')
    const members = groupMembers.get(key)
    if (members && members.length >= 2) {
      if (!emittedGroups.has(key)) {
        emittedGroups.add(key)
        const tense = tenseFromStatus(aggregateToolStatus(members))
        result.push({
          type: 'group',
          key,
          label: getToolGroupLabel(groupKey, tense),
          toolCalls: members,
        })
      }
      continue
    }

    result.push({ type: 'individual', toolCall: tc, label: getToolCallLabel(tc) })
  }

  return result
}

/**
 * Collapsed summary for a turn's tools. Progressive while any call is running
 * (`Using 12 tools` / `Reading files`); past once settled (`Used 12 tools` /
 * `Read files`). Failures stay visible on the collapsed line.
 */
export function summarizeToolTurn(toolCalls: ToolCall[], items: ToolCallDisplayItem[]): string {
  const n = toolCalls.length
  if (n === 0) return ''
  if (n === 1) {
    const only = toolCalls[0]
    return only ? getToolCallLabel(only) : ''
  }

  const status = aggregateToolStatus(toolCalls)
  const failed = toolCalls.filter((tc) => tc.status === 'error').length
  let base: string
  if (status === 'running') {
    base = `Using ${String(n)} tools`
  } else if (items.length === 1 && items[0]?.type === 'group') {
    base = items[0].label
  } else {
    base = `Used ${String(n)} tools`
  }

  if (failed > 0 && status !== 'running') {
    return `${base} · ${String(failed)} failed`
  }
  return base
}

/**
 * Build the cards for a message's tool calls. Subagent runs stay as top-level
 * cards (they have their own timeline). Everything else collapses into one
 * quiet turn rollup when there are two or more calls — including Cursor cloud /
 * ACP titles that never map onto a built-in group.
 *
 * `forceRollup` wraps even a single regular tool so a co-located reasoning trail
 * can nest inside the italic summary (rather than floating above it).
 */
export function buildToolCallDisplayItems(
  toolCalls: ToolCall[],
  opts?: { forceRollup?: boolean },
): ToolCallDisplayItem[] {
  if (toolCalls.length === 0) return []

  const subagents: ToolCall[] = []
  const regular: ToolCall[] = []
  for (const tc of toolCalls) {
    if (tc.subagent) subagents.push(tc)
    else regular.push(tc)
  }

  const result: ToolCallDisplayItem[] = []
  const grouped = buildGroupedDisplayItems(regular)
  if (regular.length >= 2 || (opts?.forceRollup === true && regular.length >= 1)) {
    result.push({
      type: 'rollup',
      key: TURN_ROLLUP_KEY,
      label: summarizeToolTurn(regular, grouped),
      children: grouped,
      toolCalls: regular,
    })
  } else {
    result.push(...grouped)
  }

  for (const tc of subagents) {
    result.push({ type: 'individual', toolCall: tc, label: getToolCallLabel(tc) })
  }
  return result
}
