import type { StreamChunk } from './stream.ts'

// invoke channels (renderer → main, returns result)
export interface IpcInvokeMap {
  // Workspace
  'workspace:open': { args: []; result: string | null }
  'workspace:get': { args: []; result: string | null }

  // File system
  'fs:readFile': { args: [path: string]; result: string }
  'fs:writeFile': { args: [path: string, content: string]; result: void }
  'fs:readdir': { args: [path: string]; result: string[] }
  'fs:watch': { args: [path: string]; result: void }
  'fs:unwatch': { args: [path: string]; result: void }

  // Agent
  'agent:run': { args: [threadId: string, prompt: string]; result: void }
  'agent:abort': { args: [threadId: string]; result: void }

  // Diff approval
  'diff:approve': { args: [path: string]; result: void }
  'diff:reject': { args: [path: string]; result: void }
  'diff:approveAll': { args: []; result: void }
  'diff:rejectAll': { args: []; result: void }

  // Approval gate (shell / MCP)
  'approval:respond': { args: [id: string, approved: boolean]; result: void }

  // Settings
  'settings:get': { args: [key: string]; result: unknown }
  'settings:set': { args: [key: string, value: unknown]; result: void }
  'settings:getKey': { args: [provider: 'anthropic' | 'openai']; result: boolean }
  'settings:setKey': { args: [provider: 'anthropic' | 'openai', key: string]; result: void }

  // Storage (generic electron-store access)
  'storage:get': { args: [key: string]; result: unknown }
  'storage:set': { args: [key: string, value: unknown]; result: void }

  // Index
  'index:query': { args: [pattern: string]; result: string[] }
}

// event channels (main → renderer, fire-and-forget)
export interface IpcEventMap {
  'agent:chunk': [threadId: string, chunk: StreamChunk]
  'agent:show_diff': [path: string, before: string, after: string, language: string]
  'agent:shell_output': [data: string]
  'agent:approval_request': [{ id: string; title: string; body: string; type: 'shell' | 'mcp' }]
  'diff:queued': [entries: { path: string; language: string }[]]
  'fs:changed': [path: string, content: string]
  'theme:changed': ['light' | 'dark']
}
