import type { StreamChunk } from './stream.ts'
import type { GitFileDiff, GitStatusResult } from './git.ts'
import type { McpServerStatus } from './mcp.ts'
import type { UsageDelta } from './thread.ts'

type Provider = 'anthropic' | 'openai' | 'lmstudio'

// invoke channels (renderer → main, returns result)
export interface IpcInvokeMap {
  // Workspace
  'workspace:open': { args: []; result: string | null }
  'workspace:get': { args: []; result: string | null }
  'workspace:set': { args: [root: string]; result: string }

  // File system
  'fs:readFile': { args: [path: string]; result: string }
  'fs:writeFile': { args: [path: string, content: string]; result: void }
  'fs:readdir': { args: [path: string]; result: string[] }
  'fs:listDir': { args: [path: string]; result: { name: string; isDir: boolean }[] }
  'fs:watch': { args: [path: string]; result: void }
  'fs:unwatch': { args: [path: string]; result: void }

  // Agent
  'agent:run': { args: [threadId: string, prompt: string]; result: void }
  'agent:abort': { args: [threadId: string]; result: void }
  'agent:clearHistory': { args: [threadId: string]; result: void }
  'agent:suggestTitle': { args: [text: string]; result: string | null }

  // Diff approval
  'diff:approve': { args: [path: string]; result: void }
  'diff:reject': { args: [path: string]; result: void }
  'diff:approveAll': { args: []; result: void }
  'diff:rejectAll': { args: []; result: void }

  // Approval gate (shell / MCP)
  'approval:respond': { args: [id: string, approved: boolean, remember?: boolean]; result: void }

  // MCP servers
  'mcp:list': { args: []; result: McpServerStatus[] }
  'mcp:reload': { args: []; result: McpServerStatus[] }
  'mcp:setEnabled': { args: [name: string, enabled: boolean]; result: McpServerStatus[] }

  // Settings
  'settings:get': { args: [key: string]; result: unknown }
  'settings:set': { args: [key: string, value: unknown]; result: void }
  'settings:getKey': { args: [provider: Provider]; result: boolean }
  'settings:setKey': { args: [provider: Provider, key: string]; result: void }
  'settings:availableProviders': { args: []; result: { anthropic: boolean; openai: boolean } }

  // Storage (generic electron-store access)
  'storage:get': { args: [key: string]; result: unknown }
  'storage:set': { args: [key: string, value: unknown]; result: void }

  // Index
  'index:query': { args: [pattern: string]; result: string[] }

  // Terminal
  'terminal:create': { args: [cols: number, rows: number]; result: string }
  'terminal:write': { args: [sessionId: string, data: string]; result: void }
  'terminal:resize': { args: [sessionId: string, cols: number, rows: number]; result: void }
  'terminal:destroy': { args: [sessionId: string]; result: void }

  // Git
  'git:status': { args: []; result: GitStatusResult | null }
  'git:fileDiff': { args: [path: string, staged: boolean]; result: GitFileDiff | null }
  'git:isAvailable': { args: []; result: boolean }

  // LM Studio
  'lmstudio:test': {
    args: [url: string, apiKey?: string]
    result: { ok: boolean; models?: string[]; error?: string }
  }
  'lmstudio:models': { args: []; result: string[] }
}

// event channels (main → renderer, fire-and-forget)
export interface IpcEventMap {
  'workspace:opened': [root: string]
  'agent:chunk': [threadId: string, chunk: StreamChunk]
  'agent:usage': [threadId: string, usage: UsageDelta]
  'agent:show_diff': [path: string, before: string, after: string, language: string]
  'agent:shell_output': [data: string]
  'agent:approval_request': [
    { id: string; title: string; body: string; type: 'shell' | 'mcp'; allowRemember?: boolean },
  ]
  'mcp:status_changed': [statuses: McpServerStatus[]]
  'diff:queued': [entries: { path: string; language: string }[]]
  'fs:changed': [path: string, content: string]
  'menu:settings': []
  'theme:changed': ['light' | 'dark']
  'terminal:output': [sessionId: string, data: string]
  'terminal:exit': [sessionId: string, code: number]
}
