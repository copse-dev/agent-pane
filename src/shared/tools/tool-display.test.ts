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

  it('labels and deep-links file deletions', () => {
    const del = { ...tc('1', 'delete_file'), args: { path: 'src/old.ts' } }
    assert.equal(getToolCallLabel(del), 'Deleted src/old.ts')
    assert.equal(getToolDisplayName('delete_file'), 'Delete file')
    assert.equal(getToolEditPath(del), 'src/old.ts')
  })

  it('labels file renames with source and destination', () => {
    const ren = { ...tc('1', 'rename_file'), args: { from: 'a.ts', to: 'b.ts' } }
    assert.equal(getToolCallLabel(ren), 'Renamed a.ts → b.ts')
    // The `from` path is the deep-link target for a rename.
    assert.equal(getToolEditPath(ren), 'a.ts')
  })

  it('labels directory creation', () => {
    const mkdir = { ...tc('1', 'make_directory'), args: { path: 'src/new' } }
    assert.equal(getToolCallLabel(mkdir), 'Created directory src/new')
  })

  it('groups file-op tools under Writing files', () => {
    assert.equal(getToolGroupKey('delete_file'), 'writing')
    assert.equal(getToolGroupKey('rename_file'), 'writing')
    assert.equal(getToolGroupKey('make_directory'), 'writing')
    const items = buildToolCallDisplayItems([tc('1', 'write_file'), tc('2', 'delete_file')])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    assert.equal(items[0].label, 'Writing files')
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
    assert.equal(items[0].label, 'Running commands')
  })

  it('groups ACP tool calls by their kind, like the built-in tools', () => {
    // External ACP agents send titles (`name`) the built-in vocabulary doesn't
    // know, but the ACP `kind` maps onto the same groups.
    assert.equal(getToolGroupKey('Terminal', 'execute'), 'shell')
    assert.equal(getToolGroupKey('Read', 'read'), 'reading')
    assert.equal(getToolGroupKey('Edit', 'edit'), 'writing')
    assert.equal(getToolGroupKey('Search', 'search'), 'searching')
    // Unmapped/absent kinds stay ungrouped.
    assert.equal(getToolGroupKey('Whatever', 'think'), null)
    assert.equal(getToolGroupKey('Whatever'), null)

    const items = buildToolCallDisplayItems([
      { ...tc('1', 'Read'), kind: 'read' },
      { ...tc('2', 'Read'), kind: 'read' },
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    assert.equal(items[0].label, 'Reading files')
  })

  it('labels an ACP shell call with its command when present', () => {
    const term = { ...tc('1', 'Terminal'), kind: 'execute', args: { command: 'npm test' } }
    assert.equal(getToolCallLabel(term), 'npm test')
    // With no command arg it falls back to the ACP title (its name).
    const bare = { ...tc('2', 'Terminal'), kind: 'execute' }
    assert.equal(getToolCallLabel(bare), 'Terminal')
  })

  it('maps known tools to human-readable names', () => {
    assert.equal(getToolDisplayName('explore'), 'Explore files')
    assert.equal(getToolDisplayName('read_file'), 'Read file')
    assert.equal(getToolDisplayName('list_dir'), 'List directory')
    assert.equal(getToolDisplayName('run_shell'), 'Run command')
    assert.equal(getToolDisplayName('read_terminal'), 'Read shell')
  })

  it('formats unknown tools from snake_case', () => {
    assert.equal(getToolDisplayName('custom_tool_name'), 'Custom Tool Name')
  })

  it('groups explore with reading tools', () => {
    const items = buildToolCallDisplayItems([tc('1', 'explore'), tc('2', 'read_file')])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    assert.equal(items[0].label, 'Reading files')
    assert.equal(items[0].toolCalls.length, 2)
  })

  it('groups multiple successful reading tools', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'read_file'),
      tc('2', 'list_dir'),
      tc('3', 'read_file'),
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    assert.equal(items[0].label, 'Reading files')
    assert.equal(items[0].toolCalls.length, 3)
  })

  it('keeps a single tool as an individual card', () => {
    const items = buildToolCallDisplayItems([tc('1', 'read_file')])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'individual')
    assert.equal(items[0].label, 'Read file')
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
    assert.equal(items[0].toolCalls.length, 2)
    assert.ok(items[0].toolCalls.every((t) => t.status !== 'error'))
    assert.equal(items[1].toolCall.id, '2')
    assert.equal(items[1].label, 'Read file')
  })

  it('collapses repeated failures into a single error group', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'mcp__mdn__get_compat', 'error'),
      tc('2', 'mcp__mdn__get_compat', 'error'),
      tc('3', 'mcp__mdn__get_compat', 'error'),
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    assert.equal(items[0].label, 'mdn (MCP)')
    assert.equal(items[0].toolCalls.length, 3)
    assert.equal(aggregateToolStatus(items[0].toolCalls), 'error')
  })

  it('separates successful and failed calls into distinct groups', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'mcp__mdn__get_compat', 'error'),
      tc('2', 'mcp__mdn__get_compat', 'error'),
      tc('3', 'mcp__mdn__get_compat'),
      tc('4', 'mcp__mdn__get_compat'),
    ])
    assert.equal(items.length, 2)
    assert.equal(items[0]?.type, 'group')
    assert.equal(items[1]?.type, 'group')
    // Error group emitted at the position of the first failed call.
    assert.equal(aggregateToolStatus(items[0].toolCalls), 'error')
    assert.equal(items[0].toolCalls.length, 2)
    assert.equal(aggregateToolStatus(items[1].toolCalls), 'done')
    assert.equal(items[1].toolCalls.length, 2)
    // Distinct keys so expansion state and DOM ids never collide.
    assert.notEqual(items[0].key, items[1].key)
  })

  it('groups git tools together', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'git_status'),
      tc('2', 'git_diff'),
      tc('3', 'gh_pr_list'),
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    assert.equal(items[0].label, 'Git')
  })

  it('maps gh tools to human-readable names', () => {
    assert.equal(getToolDisplayName('gh_pr_list'), 'List pull requests')
    assert.equal(getToolDisplayName('gh_pr_view'), 'View pull request')
    assert.equal(getToolDisplayName('gh_run_list'), 'List CI runs')
    assert.equal(getToolDisplayName('gh_run_view'), 'View CI run logs')
  })

  it('maps investigate_ci to a human-readable name', () => {
    assert.equal(getToolDisplayName('investigate_ci'), 'Investigate CI')
  })

  it('groups gh CI run tools under Git', () => {
    assert.equal(getToolGroupKey('gh_run_list'), 'git')
    assert.equal(getToolGroupKey('gh_run_view'), 'git')
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
    assert.equal(items[0].label, 'github (MCP)')
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
