// src/shared/store/events.ts
import type { ThreadStatus, ToolCall } from '@shared/types'

export interface StoreEvents {
  message_added: [threadId: string, messageId: string]
  message_token: [messageId: string, text: string]
  message_done: [messageId: string]
  tool_call_started: [messageId: string, toolCall: ToolCall]
  tool_call_updated: [messageId: string, toolCallId: string]
  thread_status_changed: [threadId: string, status: ThreadStatus]
  agent_activity: [threadId: string, label: string | null]
  threads_changed: []
  panel_changed: []
  workspace_changed: []
  projects_changed: []
  files_pane_changed: []
  right_panel_mode_changed: []
  settings_changed: []
  theme_changed: ['light' | 'dark']
  staged_diffs_changed: []
  usage_updated: [threadId: string]
  context_updated: [threadId: string]
}
