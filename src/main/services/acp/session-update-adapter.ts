import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from '@agentclientprotocol/sdk'
import type {
  AcpContentBlock,
  AcpToolCallContent,
  StreamChunk,
  ToolResultImage,
} from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import { TODOS_PLUGIN_ID, TODOS_PANEL_CONTRIBUTION_ID } from '@copse/agent/plugins/todos-plugin.ts'
import type { PanelEntry } from '@copse/agent/plugins/plugin-panel.ts'
import { isRecord } from '@shared/unknown-value.ts'

/**
 * Translate between Copse's internal `StreamChunk` stream and ACP
 * `session/update` payloads. These pure functions are the single mapping point
 * shared by both ACP roles:
 *
 * - **Agent role** (Copse is driven by an ACP client such as Buzz):
 *   {@link streamChunkToSessionUpdate} turns chunks emitted by the agent loop
 *   into updates we notify the client with.
 * - **Client role** (Copse drives an external ACP agent):
 *   {@link sessionUpdateToStreamChunks} turns updates received from the agent
 *   back into chunks the renderer already knows how to display.
 *
 * Chunks/updates without a clean counterpart (turn token accounting, outbound
 * context pressure, internal subagent events) map to `null` and are dropped.
 */

/**
 * ACP `ToolKind` for each built-in Copse tool (agent role). Without this an
 * ACP client sees every Copse tool call as `kind: 'other'` — its read/shell
 * rendering (file-read affordances, terminal/command treatment) never engages.
 * Tools not listed (todos, ask_user, mutating gh_* actions, …) stay `'other'`.
 */
const NATIVE_TOOL_ACP_KIND: Record<string, ToolKind> = {
  // Workspace reads (including read-only git queries — local, no mutation).
  read_file: 'read',
  read_skill: 'read',
  list_dir: 'read',
  staged_diffs: 'read',
  read_staged_diff: 'read',
  git_status: 'read',
  git_diff: 'read',
  git_log: 'read',
  git_show: 'read',
  // Search.
  search_code: 'search',
  search_codebase: 'search',
  semantic_search: 'search',
  find_files: 'search',
  // Shell.
  run_shell: 'execute',
  run_background: 'execute',
  // File mutations.
  write_file: 'edit',
  str_replace: 'edit',
  make_directory: 'edit',
  delete_file: 'delete',
  rename_file: 'move',
  // Network reads (web + read-only GitHub/CI).
  web_search: 'fetch',
  parallel_search: 'fetch',
  fetch_url: 'fetch',
  gh_pr_list: 'fetch',
  gh_pr_view: 'fetch',
  gh_pr_files: 'fetch',
  gh_run_list: 'fetch',
  gh_run_view: 'fetch',
  get_ci_status: 'fetch',
  wait_for_ci_checks: 'fetch',
  get_ci_failure_logs: 'fetch',
  // Subagent-backed investigations.
  explore: 'think',
  investigate_ci: 'think',
}

/** The command string of a shell tool call's args, if present. */
function shellCommandFromToolArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' && command.trim() ? command.trim() : null
}

export function streamChunkToSessionUpdate(chunk: StreamChunk): SessionUpdate | null {
  switch (chunk.type) {
    case 'text':
    case 'text_replace':
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk.text },
      }
    case 'reasoning':
      return {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: chunk.text },
      }
    case 'todo_update':
      return {
        sessionUpdate: 'plan',
        entries: chunk.todos
          // ACP plans have no cancelled state; a cancelled todo is simply no
          // longer part of the plan (each update replaces the whole list).
          .filter(
            (todo): todo is TodoItem & { status: PlanEntry['status'] } =>
              todo.status !== 'cancelled',
          )
          .map((todo): PlanEntry => ({
            content: todo.content,
            priority: todo.priority ?? 'medium',
            status: todo.status,
          })),
      }
    // P4: the `copse.todos` plugin emits `panel_update` for the plan panel
    // (level 2, id `plan`). Map that to ACP `plan` too — it is the same data,
    // just carried on the plugin-panel chunk vocabulary — so an external ACP
    // client (Buzz, cursor-agent) sees one plan stream regardless of which
    // shape Copse emits internally. Only the todos plan panel maps here; a
    // future generic panel from another plugin would carry no ACP counterpart
    // and stays as a dropped update.
    case 'panel_update': {
      if (chunk.pluginId !== TODOS_PLUGIN_ID) return null
      if (chunk.contributionId !== TODOS_PANEL_CONTRIBUTION_ID) return null
      if (chunk.data.kind !== 'list') return null
      const entries = chunk.data.rows
        .filter(
          (row): row is PanelEntry & { status: PlanEntry['status'] } =>
            !!row.status && row.status !== 'cancelled',
        )
        .map((row): PlanEntry => ({
          content: row.label,
          priority: 'medium',
          status: row.status,
        }))
      return { sessionUpdate: 'plan', entries }
    }
    case 'tool_call': {
      const kind = NATIVE_TOOL_ACP_KIND[chunk.toolCall.name] ?? 'other'
      // Shell calls title the actual command — the convention external ACP
      // agents follow (and what clients render as the terminal header). Other
      // tools keep the tool name.
      const command = kind === 'execute' ? shellCommandFromToolArgs(chunk.toolCall.args) : null
      return {
        sessionUpdate: 'tool_call',
        toolCallId: chunk.toolCall.id,
        title: command ?? chunk.toolCall.name,
        kind,
        status: 'pending',
        rawInput: chunk.toolCall.args,
      }
    }
    case 'tool_result':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: chunk.toolCallId,
        status: chunk.isError ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: chunk.result } }],
      }
    default:
      return null
  }
}

/**
 * A tool announcement may already contain output and a terminal status (Codex
 * reports MCP startup failures this way). Create its card first, then apply
 * that state through the ordinary patch path; no later notification is owed.
 */
export function sessionUpdateToStreamChunks(update: SessionUpdate): StreamChunk[] {
  const chunk = sessionUpdateToStreamChunk(update)
  if (!chunk) return []
  if (update.sessionUpdate !== 'tool_call') return [chunk]

  const initialState = sessionUpdateToStreamChunk({
    sessionUpdate: 'tool_call_update',
    toolCallId: update.toolCallId,
    // New cards already start running. Only emit a status patch when the
    // announcement says they have settled; output is useful in any state.
    ...(update.status === 'completed' || update.status === 'failed'
      ? { status: update.status }
      : {}),
    ...(update.content !== undefined ? { content: update.content } : {}),
    ...(update.locations !== undefined ? { locations: update.locations } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
  })
  return initialState ? [chunk, initialState] : [chunk]
}

function sessionUpdateToStreamChunk(update: SessionUpdate): StreamChunk | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content.type === 'text' && !update.messageId) {
        return { type: 'text', text: update.content.text }
      }
      return {
        type: 'acp_content',
        channel: 'message',
        content: normalizeContentBlock(update.content),
        ...(update.messageId ? { messageId: update.messageId } : {}),
      }
    // Reasoning renders in the Reasoning disclosure and — unlike `text` — never
    // joins the assistant's answer, thread history, or the next turn's replayed
    // transcript (buildAcpPrompt).
    case 'agent_thought_chunk':
      if (update.content.type === 'text' && !update.messageId) {
        return { type: 'reasoning', text: update.content.text }
      }
      return {
        type: 'acp_content',
        channel: 'thought',
        content: normalizeContentBlock(update.content),
        ...(update.messageId ? { messageId: update.messageId } : {}),
      }
    // ACP plan entries carry no ids and each update replaces the whole plan, so
    // index-based ids keep items stable across updates for the todo UI.
    case 'plan':
      return {
        type: 'todo_update',
        todos: update.entries.map((entry, index): TodoItem => ({
          id: `acp-plan-${String(index + 1)}`,
          content: entry.content,
          status: entry.status,
          priority: entry.priority,
        })),
      }
    case 'usage_update':
      // ACP reports the agent-owned context directly. Unlike Copse's native
      // estimator this includes the external agent's own system prompt, tools,
      // cache reads, and any other context the client cannot inspect. Reuse the
      // existing live context-pressure chunk so persistence and the footer wheel
      // consume the authoritative `used / size` pair end to end.
      return {
        type: 'context_pressure',
        contextWindow: update.size,
        conversationBudget: update.size,
        conversationTokens: update.used,
        fillRatio: update.size > 0 ? update.used / update.size : 0,
        source: 'agent-reported',
        ...(update.cost
          ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
          : {}),
      }
    case 'tool_call': {
      const title = unwrapInlineCode(update.title)
      const programmaticName =
        typeof update.name === 'string' ? unwrapInlineCode(update.name) : undefined
      return {
        type: 'tool_call',
        toolCall: {
          id: update.toolCallId,
          name: programmaticName ?? title,
          title,
          ...(programmaticName !== undefined ? { programmaticName } : {}),
          args: update.rawInput ?? {},
          // Carry a *meaningful* ACP kind so the card groups/labels like the
          // built-in tools (`getToolGroupKey`) and the terminal's "Agent tasks"
          // list can surface the agent's own shell commands (`kind: 'execute'`).
          // `'other'` is ACP's unspecified default (see the `?? 'other'` sites in
          // acp-agent-service / acp-approval-presentation), so it carries no
          // signal — dropping it keeps plain tool calls ungrouped.
          ...(update.kind && update.kind !== 'other' ? { kind: update.kind } : {}),
        },
      }
    }
    case 'tool_call_update': {
      // ACP updates are patches, and agents do not have to repeat raw input or
      // content on the terminal status update. Preserve every supplied field so
      // arguments and in-progress output are not discarded before completion.
      const status = toolCallStatus(update.status)
      const replacedContent =
        update.content !== undefined ? normalizeToolCallContent(update.content ?? []) : undefined
      const rawResult = update.rawOutput !== undefined ? mcpToolResult(update.rawOutput) : undefined
      // Some agents mirror the entire MCP envelope into ACP text content while
      // also providing `rawOutput`. The decoded MCP blocks are the lossless
      // representation in that case; otherwise ACP `content` is authoritative.
      const displayContent = rawResult?.content ?? replacedContent
      const contentResult =
        displayContent !== undefined ? toolCallContentResult(displayContent) : undefined
      const result =
        displayContent !== undefined
          ? (rawResult?.text ?? contentResult?.text ?? null)
          : update.rawOutput !== undefined
            ? formatRawToolValue(update.rawOutput)
            : undefined
      const images = displayContent !== undefined ? (contentResult?.images ?? []) : undefined
      const title = typeof update.title === 'string' ? unwrapInlineCode(update.title) : undefined
      const programmaticName =
        typeof update.name === 'string' ? unwrapInlineCode(update.name) : undefined
      const locations =
        update.locations !== undefined ? normalizeLocations(update.locations ?? []) : undefined
      if (
        status === undefined &&
        result === undefined &&
        images === undefined &&
        displayContent === undefined &&
        locations === undefined &&
        programmaticName === undefined &&
        update.kind === undefined &&
        update.rawInput === undefined
      ) {
        return null
      }
      return {
        type: 'tool_call_update',
        toolCallId: update.toolCallId,
        ...(programmaticName !== undefined ? { name: programmaticName } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(programmaticName !== undefined ? { programmaticName } : {}),
        ...(update.rawInput !== undefined ? { args: update.rawInput } : {}),
        ...(update.kind ? { kind: update.kind } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(result !== undefined
          ? { result, ...(result !== null ? { resultFormat: 'markdown' as const } : {}) }
          : {}),
        ...(images !== undefined ? { images } : {}),
        ...(displayContent !== undefined ? { content: displayContent } : {}),
        ...(locations !== undefined ? { locations } : {}),
      }
    }
    // The agent's permission (session) mode changed — either from our own
    // `session/set_mode` (issue #607) or an autonomous switch by the agent. We
    // set the mode once at session open and don't re-drive it, and Copse has no
    // in-chat mode indicator, so there's no chunk to emit; drop it explicitly
    // rather than through the fall-through so the intent is on the record.
    case 'current_mode_update':
      return null
    // Copse owns the submitted user message, slash-command registry, and thread
    // title/activity metadata. Re-emitting these agent mirrors would duplicate
    // or override the host-owned state. Config options are refreshed directly
    // on the live ACP session by `acp-client.ts`, not through the renderer.
    case 'user_message_chunk':
    case 'available_commands_update':
    case 'config_option_update':
    case 'session_info_update':
      return null
    // These v1 exports are explicitly unstable. Copse advertises neither plan
    // entities nor compaction capability, so receiving them is non-conforming;
    // they remain deferred until their lifecycle has a host-owned model.
    case 'plan_update':
    case 'plan_removed':
    case 'compaction_update':
    case 'compaction_summary_chunk':
      return null
  }
}

/**
 * Strip surrounding Markdown code punctuation from a string. External ACP agents
 * (Cursor, Claude Code) send tool-call titles as inline code — e.g.
 * `` `git diff --stat` `` or a fenced block — which renders as literal backticks
 * in Copse's plain-text tool cards and approval prompts. We unwrap a balanced
 * leading/trailing backtick run (or a ```` ``` ```` fence) but leave titles with
 * only mid-string code (`run `x` now`) untouched.
 */
export function unwrapInlineCode(text: string): string {
  const trimmed = text.trim()
  const fenced = /^`{3,}[^\n]*\n([\s\S]*?)\n?`{3,}$/.exec(trimmed)
  if (fenced?.[1] !== undefined) return fenced[1].trim()
  const inline = /^(`+)([\s\S]+?)\1$/.exec(trimmed)
  if (inline?.[2] !== undefined && inline[2].trim().length > 0) return inline[2].trim()
  return trimmed
}

interface ToolCallContentResult {
  text?: string
  images: ToolResultImage[]
}

function safeMimeType(value: string | null | undefined): string {
  return value && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream'
}

function dataUrl(mimeType: string | null | undefined, data: string): string {
  return `data:${safeMimeType(mimeType)};base64,${data}`
}

/** Preserve every ACP v1 `ContentBlock` variant in a renderer-safe shape. */
function normalizeContentBlock(content: ContentBlock): AcpContentBlock {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text }
    case 'image': {
      const mimeType = safeMimeType(content.mimeType)
      return {
        type: 'image',
        dataUrl: dataUrl(mimeType, content.data),
        mimeType,
        ...(content.uri ? { uri: content.uri } : {}),
      }
    }
    case 'audio': {
      const mimeType = safeMimeType(content.mimeType)
      return { type: 'audio', dataUrl: dataUrl(mimeType, content.data), mimeType }
    }
    case 'resource_link':
      return {
        type: 'resource_link',
        uri: content.uri,
        name: content.name,
        ...(content.title ? { title: content.title } : {}),
        ...(content.description ? { description: content.description } : {}),
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        ...(content.size !== undefined && content.size !== null ? { size: content.size } : {}),
      }
    case 'resource': {
      const resource = content.resource
      const record: unknown = resource
      if (isRecord(record) && typeof record['text'] === 'string') {
        return {
          type: 'resource',
          uri: resource.uri,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          text: record['text'],
        }
      }
      const blob = isRecord(record) && typeof record['blob'] === 'string' ? record['blob'] : ''
      const mimeType = safeMimeType(resource.mimeType)
      return {
        type: 'resource',
        uri: resource.uri,
        ...(resource.mimeType ? { mimeType } : {}),
        dataUrl: dataUrl(mimeType, blob),
      }
    }
  }
}

/** Preserve replacement order across standard, diff, and terminal tool content. */
function normalizeToolCallContent(content: ToolCallContent[]): AcpToolCallContent[] {
  return content.map((item): AcpToolCallContent => {
    switch (item.type) {
      case 'content':
        return { type: 'content', content: normalizeContentBlock(item.content) }
      case 'diff':
        return {
          type: 'diff',
          path: item.path,
          ...(item.oldText !== undefined && item.oldText !== null ? { oldText: item.oldText } : {}),
          newText: item.newText,
        }
      case 'terminal':
        return { type: 'terminal', terminalId: item.terminalId }
    }
  })
}

function normalizeLocations(
  locations: ReadonlyArray<{ path: string; line?: number | null }>,
): Array<{ path: string; line?: number }> {
  return locations.map((location) => ({
    path: location.path,
    ...(location.line !== undefined && location.line !== null ? { line: location.line } : {}),
  }))
}

/** Collect the legacy tool-card text/images derived from structured content. */
function toolCallContentResult(content: AcpToolCallContent[]): ToolCallContentResult {
  const result: ToolCallContentResult = { images: [] }
  const text: string[] = []
  for (const item of content) {
    if (item.type !== 'content') continue
    if (item.content.type === 'text') {
      text.push(item.content.text)
      continue
    }
    if (item.content.type === 'image') {
      result.images.push({ dataUrl: item.content.dataUrl, kind: 'screenshot' })
    }
  }
  if (text.length > 0) result.text = text.join('')
  return result
}

function toolCallStatus(
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | null | undefined,
): 'running' | 'done' | 'error' | undefined {
  if (status === 'pending' || status === 'in_progress') return 'running'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  return undefined
}

/**
 * MCP transports wrap successful tool content in a protocol envelope. Extract
 * text and image blocks only when doing so is lossless; errors, structured
 * results, and unknown media stay serialized so the UI never hides data it
 * cannot present directly.
 */
function unknownContentBlock(value: unknown): AcpContentBlock | null {
  if (!isRecord(value) || typeof value['type'] !== 'string') return null
  switch (value['type']) {
    case 'text':
      return typeof value['text'] === 'string' ? { type: 'text', text: value['text'] } : null
    case 'image': {
      if (typeof value['data'] !== 'string' || typeof value['mimeType'] !== 'string') return null
      const mimeType = safeMimeType(value['mimeType'])
      return {
        type: 'image',
        dataUrl: dataUrl(mimeType, value['data']),
        mimeType,
        ...(typeof value['uri'] === 'string' ? { uri: value['uri'] } : {}),
      }
    }
    case 'audio': {
      if (typeof value['data'] !== 'string' || typeof value['mimeType'] !== 'string') return null
      const mimeType = safeMimeType(value['mimeType'])
      return { type: 'audio', dataUrl: dataUrl(mimeType, value['data']), mimeType }
    }
    case 'resource_link':
      if (typeof value['uri'] !== 'string' || typeof value['name'] !== 'string') return null
      return {
        type: 'resource_link',
        uri: value['uri'],
        name: value['name'],
        ...(typeof value['title'] === 'string' ? { title: value['title'] } : {}),
        ...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
        ...(typeof value['mimeType'] === 'string' ? { mimeType: value['mimeType'] } : {}),
        ...(typeof value['size'] === 'number' ? { size: value['size'] } : {}),
      }
    case 'resource': {
      const resource = value['resource']
      if (!isRecord(resource) || typeof resource['uri'] !== 'string') return null
      if (typeof resource['text'] === 'string') {
        return {
          type: 'resource',
          uri: resource['uri'],
          ...(typeof resource['mimeType'] === 'string' ? { mimeType: resource['mimeType'] } : {}),
          text: resource['text'],
        }
      }
      if (typeof resource['blob'] !== 'string') return null
      const mimeType =
        typeof resource['mimeType'] === 'string'
          ? safeMimeType(resource['mimeType'])
          : 'application/octet-stream'
      return {
        type: 'resource',
        uri: resource['uri'],
        ...(typeof resource['mimeType'] === 'string' ? { mimeType } : {}),
        dataUrl: dataUrl(mimeType, resource['blob']),
      }
    }
    default:
      return null
  }
}

interface McpToolResult extends ToolCallContentResult {
  content: AcpToolCallContent[]
}

function mcpToolResult(value: unknown): McpToolResult | undefined {
  if (!isRecord(value)) return undefined
  const error = value['error']
  if (error !== undefined && error !== null) return undefined

  const result = value['result']
  if (!isRecord(result) || result['isError'] === true) return undefined
  const structuredContent = result['structuredContent']
  if (structuredContent !== undefined && structuredContent !== null) return undefined

  const content = result['content']
  if (!Array.isArray(content) || content.length === 0) return undefined
  const normalized: AcpToolCallContent[] = []
  for (const item of content) {
    const block = unknownContentBlock(item)
    if (!block) return undefined
    normalized.push({ type: 'content', content: block })
  }
  const visible = toolCallContentResult(normalized)
  const text = normalized.flatMap((item) =>
    item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [],
  )
  return { ...visible, ...(text.length > 0 ? { text: text.join('\n') } : {}), content: normalized }
}

function formatRawToolValue(value: unknown): string {
  if (typeof value === 'string') return value
  const contentResult = mcpToolResult(value)
  if (contentResult !== undefined) return contentResult.text ?? ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
