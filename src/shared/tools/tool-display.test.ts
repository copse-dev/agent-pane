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
  summarizeToolTurn,
} from './tool-display.ts'

function shell(id: string, command: string, status: ToolCall['status'] = 'done'): ToolCall {
  return { ...tc(id, 'run_shell', status), args: { command } }
}

function tc(id: string, name: string, status: ToolCall['status'] = 'done'): ToolCall {
  return { id, name, args: {}, status, result: status === 'running' ? null : 'ok' }
}

function rollupChildren(
  items: ReturnType<typeof buildToolCallDisplayItems>,
): ReturnType<typeof buildToolCallDisplayItems> {
  assert.equal(items.length, 1)
  assert.equal(items[0]?.type, 'rollup')
  return items[0].children
}

describe('tool-display', () => {
  it('labels file edits with the target path (tense follows status)', () => {
    const write = {
      ...tc('1', 'write_file'),
      args: { path: 'README.md', content: 'hello' },
      editStats: { additions: 27, deletions: 29 },
    }
    assert.equal(getToolCallLabel(write), 'Edited README.md')
    assert.equal(getToolCallLabel({ ...write, status: 'running' }), 'Editing README.md')
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
    assert.equal(getToolDisplayName('delete_file'), 'Deleted file')
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

  it('groups file-op tools under Edited files inside a turn rollup', () => {
    assert.equal(getToolGroupKey('delete_file'), 'writing')
    assert.equal(getToolGroupKey('rename_file'), 'writing')
    assert.equal(getToolGroupKey('make_directory'), 'writing')
    const items = buildToolCallDisplayItems([tc('1', 'write_file'), tc('2', 'delete_file')])
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Edited files')
    const children = rollupChildren(items)
    assert.equal(children.length, 1)
    assert.equal(children[0]?.type, 'group')
    assert.equal(children[0].label, 'Edited files')
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
    const shellCall = {
      ...tc('1', 'run_shell'),
      args: { command: 'cd /Users/me/agent-pane && npx vitest run 2>&1 | tail -40' },
    }
    assert.equal(getToolCallLabel(shellCall), 'npx vitest run 2>&1 | tail -40')
    // falls back to the generic name when no command is present
    assert.equal(getToolCallLabel(tc('2', 'run_shell')), 'Ran command')
    assert.equal(getToolCallLabel(tc('3', 'run_shell', 'running')), 'Running command')
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
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Ran commands')
    const children = rollupChildren(items)
    assert.equal(children[0]?.type, 'group')
    assert.equal(children[0].label, 'Ran commands')
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
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Read files')
  })

  it('labels an ACP shell call with its command when present', () => {
    const term = { ...tc('1', 'Terminal'), kind: 'execute', args: { command: 'npm test' } }
    assert.equal(getToolCallLabel(term), 'npm test')
    // With no command arg it falls back to the ACP title (its name).
    const bare = { ...tc('2', 'Terminal'), kind: 'execute' }
    assert.equal(getToolCallLabel(bare), 'Terminal')
  })

  it('maps known tools to past-tense names by default', () => {
    assert.equal(getToolDisplayName('explore'), 'Explored files')
    assert.equal(getToolDisplayName('read_file'), 'Read file')
    assert.equal(getToolDisplayName('list_dir'), 'Listed directory')
    assert.equal(getToolDisplayName('run_shell'), 'Ran command')
    assert.equal(getToolDisplayName('read_terminal'), 'Read shell')
    assert.equal(getToolDisplayName('run_checkup'), 'Ran checkup')
  })

  it('maps known tools to progressive names while running', () => {
    assert.equal(getToolDisplayName('explore', 'running'), 'Exploring files')
    assert.equal(getToolDisplayName('list_dir', 'running'), 'Listing directory')
    assert.equal(getToolDisplayName('run_shell', 'running'), 'Running command')
    assert.equal(getToolGroupLabel('reading', 'running'), 'Reading files')
    assert.equal(getToolGroupLabel('reading', 'done'), 'Read files')
  })

  it('formats unknown tools from snake_case', () => {
    assert.equal(getToolDisplayName('custom_tool_name'), 'Custom Tool Name')
  })

  it('rolls up explore with reading tools under Read files', () => {
    const items = buildToolCallDisplayItems([tc('1', 'explore'), tc('2', 'read_file')])
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Read files')
    const children = rollupChildren(items)
    assert.equal(children[0]?.type, 'group')
    assert.equal(children[0].toolCalls.length, 2)
  })

  it('groups multiple successful reading tools inside the turn rollup', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'read_file'),
      tc('2', 'list_dir'),
      tc('3', 'read_file'),
    ])
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Read files')
    const children = rollupChildren(items)
    assert.equal(children[0]?.type, 'group')
    assert.equal(children[0].toolCalls.length, 3)
  })

  it('keeps a single tool as an individual card', () => {
    const items = buildToolCallDisplayItems([tc('1', 'read_file')])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'individual')
    assert.equal(items[0].label, 'Read file')
  })

  it('forceRollup wraps a single tool so reasoning can nest inside', () => {
    const items = buildToolCallDisplayItems([tc('1', 'read_file')], { forceRollup: true })
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Read file')
    assert.equal(items[0].children.length, 1)
    assert.equal(items[0].children[0]?.type, 'individual')
  })

  it('rolls up mixed tools with a Used N tools summary', () => {
    const tools = [tc('1', 'read_file'), tc('2', 'search_code'), tc('3', 'run_shell')]
    const items = buildToolCallDisplayItems(tools)
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Used 3 tools')
    assert.equal(summarizeToolTurn(tools, items[0].children), 'Used 3 tools')
  })

  it('uses progressive Using N tools while any call is running', () => {
    const tools = [tc('1', 'read_file', 'running'), tc('2', 'search_code')]
    const items = buildToolCallDisplayItems(tools)
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Using 2 tools')
  })

  it('surfaces failures on the collapsed turn summary', () => {
    const tools = [tc('1', 'read_file'), tc('2', 'read_file', 'error'), tc('3', 'list_dir')]
    const items = buildToolCallDisplayItems(tools)
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Used 3 tools · 1 failed')
  })

  it('lists failed tools outside their success group inside the rollup', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'read_file'),
      tc('2', 'read_file', 'error'),
      tc('3', 'list_dir'),
    ])
    const children = rollupChildren(items)
    assert.equal(children.length, 2)
    assert.equal(children[0]?.type, 'group')
    assert.equal(children[1]?.type, 'individual')
    assert.equal(children[0].toolCalls.length, 2)
    assert.ok(children[0].toolCalls.every((t) => t.status !== 'error'))
    assert.equal(children[1].toolCall.id, '2')
    assert.equal(children[1].label, 'Read file')
  })

  it('collapses repeated failures into a single error group', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'mcp__mdn__get_compat', 'error'),
      tc('2', 'mcp__mdn__get_compat', 'error'),
      tc('3', 'mcp__mdn__get_compat', 'error'),
    ])
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'mdn · 3 failed')
    const children = rollupChildren(items)
    assert.equal(children[0]?.type, 'group')
    assert.equal(children[0].label, 'mdn')
    assert.equal(children[0].toolCalls.length, 3)
    assert.equal(aggregateToolStatus(children[0].toolCalls), 'error')
  })

  it('separates successful and failed calls into distinct groups', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'mcp__mdn__get_compat', 'error'),
      tc('2', 'mcp__mdn__get_compat', 'error'),
      tc('3', 'mcp__mdn__get_compat'),
      tc('4', 'mcp__mdn__get_compat'),
    ])
    const children = rollupChildren(items)
    assert.equal(children.length, 2)
    assert.equal(children[0]?.type, 'group')
    assert.equal(children[1]?.type, 'group')
    // Error group emitted at the position of the first failed call.
    assert.equal(aggregateToolStatus(children[0].toolCalls), 'error')
    assert.equal(children[0].toolCalls.length, 2)
    assert.equal(aggregateToolStatus(children[1].toolCalls), 'done')
    assert.equal(children[1].toolCalls.length, 2)
    // Distinct keys so expansion state and DOM ids never collide.
    assert.notEqual(children[0].key, children[1].key)
  })

  it('groups git tools together', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'git_status'),
      tc('2', 'git_diff'),
      tc('3', 'gh_pr_list'),
    ])
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Checked git')
  })

  it('maps gh tools to human-readable names', () => {
    assert.equal(getToolDisplayName('gh_pr_list'), 'Listed pull requests')
    assert.equal(getToolDisplayName('gh_pr_view'), 'Viewed pull request')
    assert.equal(getToolDisplayName('gh_run_list'), 'Listed CI runs')
    assert.equal(getToolDisplayName('gh_run_view'), 'Viewed CI run logs')
  })

  it('maps investigate_ci to a human-readable name', () => {
    assert.equal(getToolDisplayName('investigate_ci'), 'Investigated CI')
  })

  it('maps delegate_step to a human-readable name and keeps it ungrouped', () => {
    assert.equal(getToolDisplayName('delegate_step'), 'Delegated step')
    assert.equal(getToolGroupKey('delegate_step'), null)
  })

  it('groups gh CI run tools under git', () => {
    assert.equal(getToolGroupKey('gh_run_list'), 'git')
    assert.equal(getToolGroupKey('gh_run_view'), 'git')
  })

  it('does not category-group unrelated tools, but still rolls the turn up', () => {
    const items = buildToolCallDisplayItems([tc('1', 'read_file'), tc('2', 'search_code')])
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Used 2 tools')
    const children = rollupChildren(items)
    assert.equal(children.length, 2)
    assert.ok(children.every((item) => item.type === 'individual'))
  })

  it('humanizes MCP and ACP tool names without their server prefix', () => {
    assert.equal(getToolDisplayName('mcp__github__create_issue'), 'Create Issue')
    assert.equal(getToolDisplayName('mcp.copse.run_shell'), 'Run Shell')
  })

  it('groups MCP tools by server without exposing an internal MCP marker', () => {
    assert.equal(getToolGroupKey('mcp__github__create_issue'), 'mcp:github')
    assert.equal(getToolGroupLabel('mcp:github'), 'github')
    const items = buildToolCallDisplayItems([
      tc('1', 'mcp__github__create_issue'),
      tc('2', 'mcp__github__list_issues'),
    ])
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'github')
  })

  it('groups Copse MCP wrappers like their built-in tools', () => {
    assert.equal(getToolGroupKey('mcp__copse__git_status'), 'git')
    assert.equal(getToolGroupKey('mcp__copse__run_shell'), 'shell')
    assert.equal(getToolGroupKey('mcp__copse__read_file'), 'reading')
    assert.equal(getToolGroupKey('mcp__copse.git__status'), 'git')
    assert.equal(getToolGroupKey('mcp__copse.run__command'), 'shell')
    assert.equal(getToolGroupKey('mcp__copse__custom_tool'), 'mcp:copse')
  })

  it('does not group MCP tools from different servers, but rolls the turn up', () => {
    const items = buildToolCallDisplayItems([tc('1', 'mcp__github__x'), tc('2', 'mcp__linear__y')])
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Used 2 tools')
    const children = rollupChildren(items)
    assert.equal(children.length, 2)
    assert.ok(children.every((item) => item.type === 'individual'))
  })

  it('keeps subagent cards outside the turn rollup', () => {
    const explore: ToolCall = {
      ...tc('1', 'explore'),
      subagent: {
        id: 'sub-1',
        kind: 'explore',
        status: 'done',
        prompt: 'look around',
        summary: 'done',
        messages: [],
      },
    }
    const items = buildToolCallDisplayItems([tc('2', 'read_file'), tc('3', 'list_dir'), explore])
    assert.equal(items.length, 2)
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Read files')
    assert.equal(items[1]?.type, 'individual')
    assert.equal(items[1].toolCall.id, '1')
  })

  it('aggregateToolStatus prefers running over done', () => {
    assert.equal(
      aggregateToolStatus([tc('1', 'read_file', 'done'), tc('2', 'read_file', 'running')]),
      'running',
    )
  })
})
