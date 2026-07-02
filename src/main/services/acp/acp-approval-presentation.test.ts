import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { RequestPermissionRequest, ToolKind } from '@agentclientprotocol/sdk'
import { permissionKindLabel, presentPermissionRequest } from './acp-approval-presentation.ts'

function permissionRequest(
  toolCall: Partial<RequestPermissionRequest['toolCall']>,
): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', ...toolCall },
    options: [],
  }
}

describe('presentPermissionRequest', () => {
  it('uses a short question title instead of the raw tool title, keeping agent attribution', () => {
    const longCommand = 'cd /repo && grep -rn "needle" src | head -20'
    const p = presentPermissionRequest(
      'Claude Agent',
      permissionRequest({
        kind: 'execute',
        title: longCommand,
        rawInput: { command: longCommand },
      }),
    )
    assert.equal(p.title, 'Run shell command? — Claude Agent')
    assert.equal(p.type, 'shell')
    assert.ok(p.body.startsWith(longCommand))
  })

  it('titles each tool kind like its native counterpart', () => {
    const titleFor = (kind: ToolKind): string =>
      presentPermissionRequest('A', permissionRequest({ kind })).title
    assert.equal(titleFor('edit'), 'Edit a file? — A')
    assert.equal(titleFor('read'), 'Read a file? — A')
    assert.equal(titleFor('fetch'), 'Fetch from the web? — A')
    assert.equal(titleFor('search'), 'Search the workspace? — A')
    assert.equal(titleFor('other'), 'Run a tool? — A')
    assert.equal(presentPermissionRequest('A', permissionRequest({})).title, 'Run a tool? — A')
  })

  it('maps kinds onto the dialog types shell/web/mcp', () => {
    const typeFor = (kind: ToolKind): string =>
      presentPermissionRequest('A', permissionRequest({ kind })).type
    assert.equal(typeFor('execute'), 'shell')
    assert.equal(typeFor('fetch'), 'web')
    assert.equal(typeFor('edit'), 'mcp')
    assert.equal(typeFor('read'), 'mcp')
  })

  it('renders shell approvals as the bare command with the description as its own paragraph', () => {
    const p = presentPermissionRequest(
      'Claude Agent',
      permissionRequest({
        kind: 'execute',
        title: 'rm -rf dist',
        rawInput: { command: 'rm -rf dist', description: 'Clean build output', timeout: 5000 },
      }),
    )
    assert.equal(p.body, 'rm -rf dist\n\nClean build output\n\ntimeout: 5000')
  })

  it('falls back to the unwrapped tool title as the command when rawInput has none', () => {
    const p = presentPermissionRequest(
      'A',
      permissionRequest({ kind: 'execute', title: '`git status`' }),
    )
    assert.equal(p.body, 'git status')
  })

  it('renders an edit diff content block as -/+ snippet lines, not key: value dumps', () => {
    const p = presentPermissionRequest(
      'Claude Agent',
      permissionRequest({
        kind: 'edit',
        title: 'Edit src/foo.ts',
        content: [
          {
            type: 'diff',
            path: '/repo/src/foo.ts',
            oldText: 'const a = 1',
            newText: 'const a = 2',
          },
        ],
        rawInput: {
          file_path: '/repo/src/foo.ts',
          old_string: 'const a = 1',
          new_string: 'const a = 2',
        },
      }),
    )
    assert.equal(p.body, 'Edit src/foo.ts\n\n- const a = 1\n+ const a = 2')
  })

  it('synthesizes the diff from old_string/new_string when no diff content block is sent', () => {
    const p = presentPermissionRequest(
      'A',
      permissionRequest({
        kind: 'edit',
        title: 'Edit src/foo.ts',
        rawInput: {
          file_path: '/repo/src/foo.ts',
          old_string: 'let x = 1\nlet y = 2',
          new_string: 'let x = 3',
          replace_all: true,
        },
      }),
    )
    assert.equal(
      p.body,
      'Edit src/foo.ts\n\n- let x = 1\n- let y = 2\n+ let x = 3\n\nreplace_all: true',
    )
  })

  it('keeps the file_path line when no tool title names the file', () => {
    const p = presentPermissionRequest(
      'A',
      permissionRequest({
        kind: 'edit',
        rawInput: { file_path: '/repo/src/foo.ts', old_string: 'a', new_string: 'b' },
      }),
    )
    assert.equal(p.body, '- a\n+ b\n\nfile_path: /repo/src/foo.ts')
  })

  it('shows a new-file Write (null oldText) as added lines only, truncated per side', () => {
    const newText = Array.from({ length: 45 }, (_, i) => `line ${String(i + 1)}`).join('\n')
    const p = presentPermissionRequest(
      'A',
      permissionRequest({
        kind: 'edit',
        title: 'Write notes.md',
        content: [{ type: 'diff', path: '/repo/notes.md', oldText: null, newText }],
        rawInput: { file_path: '/repo/notes.md', content: newText },
      }),
    )
    const lines = p.body.split('\n')
    assert.equal(lines[0], 'Write notes.md')
    assert.equal(lines[2], '+ line 1')
    assert.equal(lines[41], '+ line 40')
    assert.equal(lines[42], '… (+5 more lines)')
    assert.equal(lines.length, 43)
  })

  it('includes text content blocks (e.g. a subtask prompt) without duplicating shown fields', () => {
    const p = presentPermissionRequest(
      'A',
      permissionRequest({
        kind: 'think',
        title: 'Investigate flaky test',
        content: [
          { type: 'content', content: { type: 'text', text: 'Find why foo.test.ts flakes' } },
        ],
        rawInput: { description: 'Investigate flaky test', prompt: 'Find why foo.test.ts flakes' },
      }),
    )
    assert.equal(p.body, 'Investigate flaky test\n\nFind why foo.test.ts flakes')
  })

  it('renders leftover multi-line scalars as indented blocks, not inline key: value', () => {
    const p = presentPermissionRequest(
      'A',
      permissionRequest({ title: 'Tool', rawInput: { notes: 'first\nsecond' } }),
    )
    assert.equal(p.body, 'Tool\n\nnotes:\n  first\n  second')
  })

  it('keeps nested values as pretty JSON after the scalar lines', () => {
    const p = presentPermissionRequest(
      'A',
      permissionRequest({
        title: 'Edit file',
        rawInput: { path: 'src/a.ts', edits: [{ old: 'a', new: 'b' }] },
      }),
    )
    assert.equal(
      p.body,
      'Edit file\n\npath: src/a.ts\n' +
        JSON.stringify({ edits: [{ old: 'a', new: 'b' }] }, null, 2),
    )
  })

  it('unwraps inline code from string input and skips null-ish fields', () => {
    const p = presentPermissionRequest(
      'A',
      permissionRequest({ title: '`fetch`', kind: 'fetch', rawInput: '`curl https://x`' }),
    )
    assert.equal(p.body, 'fetch\n\ncurl https://x')
    const empty = presentPermissionRequest(
      'A',
      permissionRequest({
        title: '`fetch`',
        kind: 'fetch',
        rawInput: { url: null, method: undefined },
      }),
    )
    assert.equal(empty.body, 'fetch')
  })

  it('drops lines that would only repeat the tool title and falls back when nothing is left', () => {
    const p = presentPermissionRequest(
      'A',
      permissionRequest({ title: '`npm test`', rawInput: { description: 'npm test' } }),
    )
    assert.equal(p.body, 'npm test')
    assert.equal(presentPermissionRequest('A', permissionRequest({})).body, 'Run this tool call?')
  })
})

describe('permissionKindLabel', () => {
  it('names known ACP tool kinds in plain language', () => {
    assert.equal(permissionKindLabel('execute'), 'terminal commands')
    assert.equal(permissionKindLabel('read'), 'file reads')
    assert.equal(permissionKindLabel('edit'), 'file edits')
    assert.equal(permissionKindLabel('fetch'), 'web fetches')
  })

  it('quotes unknown kinds instead of guessing', () => {
    assert.equal(permissionKindLabel('think'), '"think" tool calls')
  })
})
