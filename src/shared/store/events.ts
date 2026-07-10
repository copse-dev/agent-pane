// src/shared/store/events.ts
import type { ThreadStatus, ToolCall } from '@shared/types'
import type { CanvasArtefact } from '@shared/types/canvas.ts'

export interface StoreEvents {
  message_added: [threadId: string, messageId: string]
  message_queued: [threadId: string, messageId: string]
  message_token: [messageId: string, text: string]
  message_reasoning: [messageId: string, text: string]
  message_done: [messageId: string]
  tool_call_started: [messageId: string, toolCall: ToolCall]
  tool_call_updated: [messageId: string, toolCallId: string]
  thread_status_changed: [threadId: string, status: ThreadStatus]
  agent_activity: [threadId: string, label: string | null]
  threads_changed: []
  // Draft composer text changed for a thread. Kept separate from
  // `threads_changed` so high-cost listeners (e.g. the conversation rebuild)
  // are not re-run on every keystroke while the user is typing.
  thread_draft_changed: [threadId: string]
  // A fresh chat was opened (new blank thread reused or created). Used to refresh
  // provider-reported model context windows so the new chat reflects current limits.
  new_thread_opened: []
  panel_changed: []
  explorer_reveal: [path: string]
  workspace_changed: []
  projects_changed: []
  files_pane_changed: []
  right_panel_mode_changed: []
  // Request the Changes panel to reveal a specific workspace-relative file diff.
  git_change_navigate: [path: string]
  browser_url_requested: [url: string]
  pr_open_requested: [owner: string, repo: string, number: number]
  // An MCP-UI artefact should be rendered in the canvas (Browser pane).
  canvas_artefact_requested: [artefact: CanvasArtefact]
  settings_changed: []
  theme_changed: ['light' | 'dark']
  staged_diffs_changed: []
  usage_updated: [threadId: string]
  context_updated: [threadId: string]
  todos_changed: [threadId: string]
  review_changed: [threadId: string, messageId: string]
  comparison_changed: [threadId: string]
  git_branch_changed: []
  composer_draft_flush: []
  // Terminal tab: the user selected an agent task to view (id) or cleared it
  // (null). Lets the shells list drop its active highlight while a task panel
  // takes over the viewer, and vice versa.
  agent_task_selected: [taskId: string | null]
  // Terminal tab: a shell tab was activated, so any agent-task panel showing in
  // the viewer should yield back to the live terminal.
  shell_tab_activated: []
  // The set of non-focused threads awaiting user input (a pending approval or
  // ask_user question) changed. Drives the sidebar attention indicator.
  attention_changed: []
}
