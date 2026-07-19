import type { PlanEntry, SessionUpdate, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import { TODOS_PACK_ID, TODOS_PANEL_CONTRIBUTION_ID } from '@copse/agent/packs/todos-pack.ts'
import type { PanelEntry } from '@copse/agent/packs/pack-panel.ts'

/**
 * Translate between Copse's internal `StreamChunk` stream and ACP
 * `session/update` payloads. These pure functions are the single mapping point
 * shared by both ACP roles:
 *
 * - **Agent role** (Copse is driven by an ACP client such as Buzz):
 *   {@link streamChunkToSessionUpdate} turns chunks emitted by the agent loop
 *   into updates we notify the client with.
 * - **Client role** (Copse drives an external ACP agent):
 *   {@link sessionUpdateToStreamChunk} turns updates received from the agent
 *   back into chunks the renderer already knows how to display.
 *
 * Chunks/updates without a clean counterpart (usage accounting, context
 * pressure, internal subagent events) map to `null` and are dropped.
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
            priority: 'medium',
            status: todo.status,
          })),
      }
    // P4: the `copse.todos` pack emits `panel_update` for the plan panel
    // (level 2, id `plan`). Map that to ACP `plan` too — it is the same data,
    // just carried on the pack-panel chunk vocabulary — so an external ACP
    // client (Buzz, cursor-agent) sees one plan stream regardless of which
    // shape Copse emits internally. Only the todos plan panel maps here; a
    // future generic panel from another pack would carry no ACP counterpart
    // and stays as a dropped update.
    case 'panel_update': {
      if (chunk.packId !== TODOS_PACK_ID) return null
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

export function sessionUpdateToStreamChunk(update: SessionUpdate): StreamChunk | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text' ? { type: 'text', text: update.content.text } : null
    // Reasoning renders in the "Thinking" disclosure and — unlike `text` — never
    // joins the assistant's answer, thread history, or the next turn's replayed
    // transcript (buildAcpPrompt).
    case 'agent_thought_chunk':
      return update.content.type === 'text'
        ? { type: 'reasoning', text: update.content.text }
        : null
    // ACP plan entries carry no ids and each update replaces the whole plan, so
    // index-based ids keep items stable across updates for the todo UI.
    case 'plan':
      return {
        type: 'todo_update',
        todos: update.entries.map((entry, index): TodoItem => ({
          id: `acp-plan-${String(index + 1)}`,
          content: entry.content,
          status: entry.status,
        })),
      }
    case 'tool_call':
      return {
        type: 'tool_call',
        toolCall: {
          id: update.toolCallId,
          name: unwrapInlineCode(update.title),
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
    case 'tool_call_update': {
      // Only surface terminal states; intermediate progress has no chunk.
      if (update.status !== 'completed' && update.status !== 'failed') return null
      return {
        type: 'tool_result',
        toolCallId: update.toolCallId,
        result: toolCallContentText(update.content),
        isError: update.status === 'failed',
        // External agents author tool output as Markdown (fenced code blocks,
        // lists, prose). Tag it so the renderer runs it through the Markdown
        // pipeline instead of dumping literal backticks into a `<pre>`.
        resultFormat: 'markdown',
      }
    }
    // The agent's permission (session) mode changed — either from our own
    // `session/set_mode` (issue #607) or an autonomous switch by the agent. We
    // set the mode once at session open and don't re-drive it, and Copse has no
    // in-chat mode indicator, so there's no chunk to emit; drop it explicitly
    // rather than through the fall-through so the intent is on the record.
    case 'current_mode_update':
      return null
    default:
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

/** Collect the plain text from a tool call's content blocks. */
function toolCallContentText(content: ToolCallContent[] | null | undefined): string {
  if (!content) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item.type === 'content' && item.content.type === 'text') parts.push(item.content.text)
  }
  return parts.join('')
}
