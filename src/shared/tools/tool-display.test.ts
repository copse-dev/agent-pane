import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '@shared/types'
import {
  buildToolCallDisplayItems,
  getToolDisplayName,
  getToolCallLabel,
  getToolEditPath,
  getToolGroupKey,
  getToolGroupLabel,
  aggregateToolStatus,
  stripShellCdPrefix,
  shellCommandLabel,
  shellCommandsFromToolCalls,
} from './tool-display.ts'

function shell(id: string, command: string, status: ToolCall['status'] = 'done'): ToolCall {
  return { ...tc(id, 'run_shell', status), args: { command } }
}

function tc(id: string, name: string, status: ToolCall['status'] = 'done'): ToolCall {
  return { id, name, args: {}, status, result: status === 'running' ? null : 'ok' }
}

describe('tool-display', () => {
  it('labels file edits with the target path', () => {
    const write = {
      ...tc('1', 'write_file'),
      args: { path: 'README.md', content: 'hello' },
      editStats: { additions: 27, deletions: 29 },
    }
    assert.equal(getToolCallLabel(write), 'Edited README.md')
    const replace = {
      ...tc('2', 'str_replace'),
      args: { path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
    }
    assert.equal(getToolCallLabel(replace), 'Edited src/foo.ts')
  })

  it('exposes the edited path for file-edit tools only', () => {
    const write = { ...tc('1', 'write_file'), args: { path: 'README.md', content: 'x' } }
    assert.equal(getToolEditPath(write), 'README.md')
    assert.equal(getToolEditPath(tc('2', 'run_shell')), null)
    assert.equal(getToolEditPath(tc('3', 'read_file')), null)
  })

  it('strips a leading `cd <path> &&` workspace prefix from commands', () => {
    assert.equal(stripShellCdPrefix('cd /Users/me/proj && npm test'), 'npm test')
    assert.equal(stripShellCdPrefix("cd '/path with spaces' && ls"), 'ls')
    assert.equal(stripShellCdPrefix('npm test'), 'npm test')
    // only the leading cd is removed, not a later one
    assert.equal(stripShellCdPrefix('cd /a && cd /b && ls'), 'cd /b && ls')
  })

  it('builds a compact single-line command label', () => {
    assert.equal(shellCommandLabel('cd /proj && npm   test'), 'npm test')
    const long = `echo ${'x'.repeat(200)}`
    const label = shellCommandLabel(long)
    assert.ok(label.length <= 96)
    assert.ok(label.endsWith('…'))
  })

  it('labels run_shell with the cd-stripped command', () => {
    const shell = {
      ...tc('1', 'run_shell'),
      args: { command: 'cd /Users/me/agent-pane && npx vitest run 2>&1 | tail -40' },
    }
    assert.equal(getToolCallLabel(shell), 'npx vitest run 2>&1 | tail -40')
    // falls back to the generic name when no command is present
    assert.equal(getToolCallLabel(tc('2', 'run_shell')), 'Run command')
  })

  it('collects cd-stripped commands from run_shell tool calls', () => {
    const commands = shellCommandsFromToolCalls([
      shell('1', 'cd /p && npx vitest run a.test.ts'),
      shell('2', 'git diff'),
      shell('3', 'should be skipped', 'error'),
      tc('4', 'read_file'),
    ])
    assert.deepEqual(commands, ['npx vitest run a.test.ts', 'git diff'])
  })

  it('shell groups keep the generic label (LLM summary applied at render)', () => {
    const items = buildToolCallDisplayItems([shell('1', 'npm test'), shell('2', 'git diff')])
    assert.equal(items[0]?.type, 'group')
    if (items[0]?.type === 'group') assert.equal(items[0].label, 'Running commands')
  })

  it('maps known tools to human-readable names', () => {
    assert.equal(getToolDisplayName('explore'), 'Explore files')
    assert.equal(getToolDisplayName('read_file'), 'Read file')
    assert.equal(getToolDisplayName('list_dir'), 'List directory')
    assert.equal(getToolDisplayName('run_shell'), 'Run command')
  })

  it('formats unknown tools from snake_case', () => {
    assert.equal(getToolDisplayName('custom_tool_name'), 'Custom Tool Name')
  })

  it('groups explore with reading tools', () => {
    const items = buildToolCallDisplayItems([tc('1', 'explore'), tc('2', 'read_file')])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    if (items[0]?.type === 'group') {
      assert.equal(items[0].label, 'Reading files')
      assert.equal(items[0].toolCalls.length, 2)
    }
  })

  it('groups multiple successful reading tools', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'read_file'),
      tc('2', 'list_dir'),
      tc('3', 'read_file'),
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    if (items[0]?.type === 'group') {
      assert.equal(items[0].label, 'Reading files')
      assert.equal(items[0].toolCalls.length, 3)
    }
  })

  it('keeps a single tool as an individual card', () => {
    const items = buildToolCallDisplayItems([tc('1', 'read_file')])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'individual')
    if (items[0]?.type === 'individual') {
      assert.equal(items[0].label, 'Read file')
    }
  })

  it('lists failed tools outside their group', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'read_file'),
      tc('2', 'read_file', 'error'),
      tc('3', 'list_dir'),
    ])
    assert.equal(items.length, 2)
    assert.equal(items[0]?.type, 'group')
    assert.equal(items[1]?.type, 'individual')
    if (items[0]?.type === 'group') {
      assert.equal(items[0].toolCalls.length, 2)
      assert.ok(items[0].toolCalls.every((t) => t.status !== 'error'))
    }
    if (items[1]?.type === 'individual') {
      assert.equal(items[1].toolCall.id, '2')
      assert.equal(items[1].label, 'Read file')
    }
  })

  it('groups git tools together', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'git_status'),
      tc('2', 'git_diff'),
      tc('3', 'gh_pr_list'),
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    if (items[0]?.type === 'group') assert.equal(items[0].label, 'Git')
  })

  it('maps gh tools to human-readable names', () => {
    assert.equal(getToolDisplayName('gh_pr_list'), 'List pull requests')
    assert.equal(getToolDisplayName('gh_pr_view'), 'View pull request')
  })

  it('does not group unrelated tools', () => {
    const items = buildToolCallDisplayItems([tc('1', 'read_file'), tc('2', 'search_code')])
    assert.equal(items.length, 2)
    assert.ok(items.every((item) => item.type === 'individual'))
  })

  it('humanizes MCP tool names with their server prefix', () => {
    assert.equal(getToolDisplayName('mcp__github__create_issue'), 'github: Create Issue')
  })

  it('groups MCP tools by server', () => {
    assert.equal(getToolGroupKey('mcp__github__create_issue'), 'mcp:github')
    assert.equal(getToolGroupLabel('mcp:github'), 'github (MCP)')
    const items = buildToolCallDisplayItems([
      tc('1', 'mcp__github__create_issue'),
      tc('2', 'mcp__github__list_issues'),
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    if (items[0]?.type === 'group') assert.equal(items[0].label, 'github (MCP)')
  })

  it('does not group MCP tools from different servers', () => {
    const items = buildToolCallDisplayItems([tc('1', 'mcp__github__x'), tc('2', 'mcp__linear__y')])
    assert.equal(items.length, 2)
    assert.ok(items.every((item) => item.type === 'individual'))
  })

  it('aggregateToolStatus prefers running over done', () => {
    assert.equal(
      aggregateToolStatus([tc('1', 'read_file', 'done'), tc('2', 'read_file', 'running')]),
      'running',
    )
  })
})
