import type { ToolCall } from '@shared/types'

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  explore: 'Explore files',
  read_file: 'Read file',
  list_dir: 'List directory',
  search_code: 'Search code',
  search_codebase: 'Search codebase',
  semantic_search: 'Semantic search',
  find_files: 'Find files',
  web_search: 'Web search',
  fetch_url: 'Fetch page',
  browser_navigate: 'Open browser',
  browser_snapshot: 'Page snapshot',
  browser_screenshot: 'Screenshot',
  browser_click: 'Click element',
  browser_type: 'Type text',
  browser_tabs: 'Browser tabs',
  git_status: 'Git status',
  git_diff: 'Git diff',
  git_log: 'Git log',
  gh_pr_list: 'List pull requests',
  gh_pr_view: 'View pull request',
  gh_run_list: 'List CI runs',
  gh_run_view: 'View CI run logs',
  investigate_ci: 'Investigate CI',
  get_ci_status: 'CI status',
  wait_for_ci_checks: 'Wait for CI',
  get_ci_failure_logs: 'CI failure logs',
  write_file: 'Write file',
  str_replace: 'Replace in file',
  run_shell: 'Run command',
  update_todos: 'Update plan',
}

const TOOL_GROUPS: Record<string, { tools: string[]; label: string }> = {
  reading: { tools: ['explore', 'read_file', 'list_dir'], label: 'Reading files' },
  searching: {
    tools: ['search_code', 'search_codebase', 'semantic_search', 'find_files'],
    label: 'Searching',
  },
  web: { tools: ['web_search', 'fetch_url'], label: 'Web' },
  browser: {
    tools: [
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_tabs',
    ],
    label: 'Browser',
  },
  git: {
    tools: [
      'git_status',
      'git_diff',
      'git_log',
      'gh_pr_list',
      'gh_pr_view',
      'gh_run_list',
      'gh_run_view',
      'get_ci_status',
      'wait_for_ci_checks',
      'get_ci_failure_logs',
    ],
    label: 'Git',
  },
  writing: { tools: ['write_file', 'str_replace'], label: 'Writing files' },
  shell: { tools: ['run_shell'], label: 'Running commands' },
}

const TOOL_TO_GROUP = new Map<string, string>(
  Object.entries(TOOL_GROUPS).flatMap(([key, { tools }]) => tools.map((name) => [name, key])),
)

export type ToolCallDisplayItem =
  | { type: 'group'; key: string; label: string; toolCalls: ToolCall[] }
  | { type: 'individual'; toolCall: ToolCall; label: string }

const MCP_PREFIX = 'mcp__'
const MCP_GROUP_PREFIX = 'mcp:'

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

export function getToolDisplayName(name: string): string {
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name]
  const mcp = parseMcp(name)
  if (mcp) return `${mcp.server}: ${formatToolNameFallback(mcp.tool)}`
  return formatToolNameFallback(name)
}

function fileEditPath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const path = (args as Record<string, unknown>)['path']
  return typeof path === 'string' && path.length > 0 ? path : null
}

/** Workspace-relative path a file-edit tool touched, or null for non-edit tools. */
export function getToolEditPath(tc: ToolCall): string | null {
  if (tc.name !== 'write_file' && tc.name !== 'str_replace') return null
  return fileEditPath(tc.args)
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
  if (!args || typeof args !== 'object') return null
  const command = (args as Record<string, unknown>)['command']
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
 * Human label for a tool card — file edits show `Edited <path>` and shell
 * commands surface the actual (cd-stripped) command instead of a generic
 * "Run command", so the user can see what ran without expanding the card.
 */
export function getToolCallLabel(tc: ToolCall): string {
  if (tc.name === 'write_file' || tc.name === 'str_replace') {
    const path = fileEditPath(tc.args)
    if (path) return `Edited ${path}`
  }
  if (tc.name === 'run_shell') {
    const command = shellCommandArg(tc.args)
    if (command) return shellCommandLabel(command)
  }
  return getToolDisplayName(tc.name)
}

export function getToolGroupKey(name: string): string | null {
  const builtIn = TOOL_TO_GROUP.get(name)
  if (builtIn) return builtIn
  const mcp = parseMcp(name)
  if (mcp) return `${MCP_GROUP_PREFIX}${mcp.server}`
  return null
}

export function getToolGroupLabel(key: string): string {
  if (key.startsWith(MCP_GROUP_PREFIX)) {
    return `${key.slice(MCP_GROUP_PREFIX.length)} (MCP)`
  }
  return TOOL_GROUPS[key]?.label ?? key
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

export function buildToolCallDisplayItems(toolCalls: ToolCall[]): ToolCallDisplayItem[] {
  if (toolCalls.length === 0) return []

  const groupMembers = new Map<string, ToolCall[]>()
  for (const tc of toolCalls) {
    const groupKey = getToolGroupKey(tc.name)
    if (!groupKey) continue
    const key = bucketKey(groupKey, tc.status === 'error')
    const members = groupMembers.get(key) ?? []
    members.push(tc)
    groupMembers.set(key, members)
  }

  const result: ToolCallDisplayItem[] = []
  const emittedGroups = new Set<string>()

  for (const tc of toolCalls) {
    const groupKey = getToolGroupKey(tc.name)
    if (!groupKey) {
      result.push({ type: 'individual', toolCall: tc, label: getToolCallLabel(tc) })
      continue
    }

    const key = bucketKey(groupKey, tc.status === 'error')
    const members = groupMembers.get(key)
    if (members && members.length >= 2) {
      if (!emittedGroups.has(key)) {
        emittedGroups.add(key)
        result.push({ type: 'group', key, label: getToolGroupLabel(groupKey), toolCalls: members })
      }
      continue
    }

    result.push({ type: 'individual', toolCall: tc, label: getToolCallLabel(tc) })
  }

  return result
}
