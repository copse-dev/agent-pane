// src/shared/store/events.ts
import type { ThreadStatus, ToolCall } from '@shared/types'
import type { CanvasArtefact } from '@shared/types/canvas.ts'

export interface StoreEvents {
  message_added: [threadId: string, messageId: string]
  message_queued: [threadId: string, messageId: string]
  message_token: [messageId: string, text: string]
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
  panel_changed: []
  explorer_reveal: [path: string]
  workspace_changed: []
  projects_changed: []
  files_pane_changed: []
  right_panel_mode_changed: []
  // Request the Changes panel to reveal a specific workspace-relative file diff.
  git_change_navigate: [path: string]
  browser_url_requested: [url: string]
  // An MCP-UI artefact should be rendered in the canvas (Browser pane).
  canvas_artefact_requested: [artefact: CanvasArtefact]
  settings_changed: []
  theme_changed: ['light' | 'dark']
  staged_diffs_changed: []
  usage_updated: [threadId: string]
  context_updated: [threadId: string]
  todos_changed: [threadId: string]
  git_branch_changed: []
  composer_draft_flush: []
}
