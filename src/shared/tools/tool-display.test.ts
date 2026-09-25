import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '@shared/types'
import {
  buildSubagentDisplayItems,
  buildToolCallDisplayItems,
  buildToolRunDisplayItems,
  getToolDisplayName,
  getToolCallLabel,
  getToolEditPath,
  getToolGroupKey,
  getToolGroupLabel,
  aggregateToolStatus,
  RUN_ROLLUP_KEY,
  stripShellCdPrefix,
  shellCommandLabel,
  shellCommandsFromToolCalls,
  summarizeToolTurn,
} from './tool-display.ts'
import { deriveToolRuns, type ToolRunMessage } from './tool-runs.ts'

function shell(id: string, command: string, status: ToolCall['status'] = 'done'): ToolCall {
  return { ...tc(id, 'run_shell', status), args: { command } }
}

function tc(id: string, name: string, status: ToolCall['status'] = 'done'): ToolCall {
  return { id, name, args: {}, status, result: status === 'running' ? null : 'ok' }
}

function rollupChildren(
  items: ReturnType<typeof buildToolCallDisplayItems>,
): ReturnType<typeof buildToolCallDisplayItems> {
  assert.equal(items[0]?.type, 'rollup')
  return items[0].children
}

describe('tool-display', () => {
  it('identifies which MCP server failed to start', () => {
    assert.equal(getToolDisplayName('mcp__docs__startup'), 'docs startup')
    assert.equal(getToolDisplayName('mcp__issue_tracker__startup'), 'issue_tracker startup')
    assert.equal(getToolDisplayName('mcp__docs__read_page'), 'Read Page')
    assert.equal(
      getToolCallLabel({
        ...tc('startup', 'mcp__copse__startup', 'error'),
        title: 'mcp.copse.startup',
      }),
      'copse startup',
    )
  })

  it('labels worktree preparation tools and groups them by effect', () => {
    assert.equal(getToolDisplayName('preflight_worktree'), 'Checked worktree')
    assert.equal(getToolDisplayName('preflight_worktree', 'running'), 'Checking worktree')
    assert.equal(getToolGroupKey('preflight_worktree'), 'reading')
    assert.equal(getToolDisplayName('prepare_worktree'), 'Prepared worktree')
    assert.equal(getToolDisplayName('prepare_worktree', 'running'), 'Preparing worktree')
    assert.equal(getToolGroupKey('prepare_worktree'), 'shell')
  })

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
    assert.equal(children.length, 2)
    assert.ok(children.every((child) => child.type === 'individual'))
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
    assert.deepEqual(
      children.map((child) => child.label),
      ['npm test', 'git diff'],
    )
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
    assert.equal(children.length, 2)
    assert.ok(children.every((child) => child.type === 'individual'))
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
    assert.equal(children.length, 3)
    assert.ok(children.every((child) => child.type === 'individual'))
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

  it('keeps failed tools beside the collapsed successes', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'read_file'),
      tc('2', 'read_file', 'error'),
      tc('3', 'list_dir'),
    ])
    assert.equal(items.length, 2)
    const children = rollupChildren(items)
    assert.deepEqual(
      children.map((child) => child.type === 'individual' && child.toolCall.id),
      ['1', '3'],
    )
    assert.equal(items[1]?.type, 'individual')
    assert.equal(items[1].toolCall.id, '2')
  })
  it('groups repeated failures outside the quiet activity', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'mcp__mdn__get_compat', 'error'),
      tc('2', 'mcp__mdn__get_compat', 'error'),
      tc('3', 'mcp__mdn__get_compat', 'error'),
    ])
    assert.equal(items[0]?.label, 'mdn · 3 failed')
    assert.equal(items[1]?.type, 'group')
    assert.equal(items[1].toolCalls.length, 3)
    assert.equal(aggregateToolStatus(items[1].toolCalls), 'error')
  })
  it('keeps failures visible while another tool is running', () => {
    const items = buildToolCallDisplayItems([
      tc('1', 'read_file', 'error'),
      tc('2', 'read_file', 'running'),
    ])
    assert.equal(items[0]?.label, 'Using 2 tools · 1 failed')
    assert.equal(items[1]?.type, 'individual')
    assert.equal(items[1].toolCall.status, 'error')
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

  it('labels a custom agent card with the agent name, not a generic verb', () => {
    const running = getToolCallLabel({
      ...tc('1', 'task', 'running'),
      args: { subagent_type: 'reviewer', prompt: 'check auth' },
    })
    assert.equal(running, 'Running reviewer')

    const done = getToolCallLabel({
      ...tc('1', 'task'),
      args: { subagent_type: 'reviewer', prompt: 'check auth' },
    })
    assert.equal(done, 'Ran reviewer')
  })

  it('prefers the persisted session name, so a reopened thread still names the agent', () => {
    const label = getToolCallLabel({
      // A reloaded thread has the session but not necessarily readable args.
      ...tc('1', 'task'),
      subagent: {
        id: 's1',
        kind: 'custom',
        status: 'done',
        prompt: 'check auth',
        summary: null,
        messages: [],
        agentName: 'reviewer',
      },
    })
    assert.equal(label, 'Ran reviewer')
  })

  it('falls back to a generic label when no agent name is recoverable', () => {
    assert.equal(getToolCallLabel(tc('1', 'task')), 'Ran agent')
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
    assert.equal(getToolDisplayName('mcp.copse.run_shell'), 'Ran command')
    assert.equal(getToolDisplayName('mcp.copse.run_shell', 'running'), 'Running command')
    assert.equal(getToolDisplayName('mcp.copse.custom_tool'), 'Custom Tool')
    assert.equal(getToolDisplayName('mcp.docs.startup'), 'docs startup')
  })

  it('formats raw ACP titles like native Copse tools in every status', () => {
    const statuses: ToolCall['status'][] = ['running', 'done', 'error']
    for (const prefix of ['mcp.copse.', 'mcp__copse__']) {
      for (const name of ['run_shell', 'read_file', 'git_status', 'search_code', 'write_file']) {
        for (const status of statuses) {
          const native = tc('wrapped', name, status)
          const wrapped = { ...native, name: `${prefix}${name}`, title: `${prefix}${name}` }
          assert.equal(getToolCallLabel(wrapped), getToolCallLabel(native))
          assert.equal(getToolGroupKey(wrapped.name), getToolGroupKey(native.name))
        }
      }
      const shell = {
        ...tc('shell', `${prefix}run_shell`, 'error'),
        title: `${prefix}run_shell`,
        args: { command: 'cd /workspace && pnpm test' },
      }
      assert.equal(getToolCallLabel(shell), 'pnpm test')
      const edit = {
        ...tc('edit', `${prefix}write_file`),
        title: `${prefix}write_file`,
        args: { path: 'src/app.ts', content: 'export {}' },
      }
      assert.equal(getToolCallLabel(edit), 'Edited src/app.ts')
      assert.equal(getToolEditPath(edit), 'src/app.ts')
    }
  })

  it('normalizes identifier titles without replacing descriptive ACP titles', () => {
    assert.equal(
      getToolCallLabel({ ...tc('1', 'run_shell'), title: 'mcp.copse.run_shell' }),
      'Ran command',
    )
    assert.equal(
      getToolCallLabel({ ...tc('2', 'mcp__copse__git_status'), title: 'Check the release branch' }),
      'Check the release branch',
    )
    assert.equal(
      getToolCallLabel({ ...tc('3', 'mcp__copse__read_file'), title: 'MCP: tool' }),
      'Read file',
    )
    assert.equal(
      getToolCallLabel({
        ...tc('4', 'shell'),
        kind: 'execute',
        title: 'mcp.copse.run_shell --help',
      }),
      'mcp.copse.run_shell --help',
    )
    assert.equal(
      getToolCallLabel({
        ...tc('5', 'mcp__github__run_shell'),
        title: 'mcp.github.run_shell',
        args: { command: 'pnpm test' },
      }),
      'Run Shell',
    )
  })

  it('keeps acronyms upper case in humanized tool names', () => {
    assert.equal(getToolDisplayName('mcp__copse__gh_pr_create'), 'GH PR Create')
    assert.equal(getToolDisplayName('gh_pr_files'), 'GH PR Files')
    assert.equal(getToolDisplayName('mcp__copse__get_ci_failure_logs'), 'Fetched CI failure logs')
    assert.equal(getToolDisplayName('resolve_url'), 'Resolve URL')
    assert.equal(getToolDisplayName('get_thread_id'), 'Get Thread ID')
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

  it('keeps a proposed thread outside the turn rollup', () => {
    // The offer is addressed to the user, so it cannot be folded into
    // `Used N tools` where nobody would ever see it.
    const items = buildToolCallDisplayItems([
      tc('2', 'read_file'),
      tc('3', 'list_dir'),
      tc('4', 'propose_thread'),
    ])
    assert.equal(items.length, 2)
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].toolCalls.length, 2)
    assert.equal(items[1]?.type, 'individual')
    assert.equal(items[1].toolCall.id, '4')
    assert.equal(items[1].label, 'Proposed a thread')
  })

  it('aggregateToolStatus prefers running over done', () => {
    assert.equal(
      aggregateToolStatus([tc('1', 'read_file', 'done'), tc('2', 'read_file', 'running')]),
      'running',
    )
  })
})

function assistant(id: string, extra: Partial<ToolRunMessage> = {}): ToolRunMessage {
  return { id, role: 'assistant', content: '', toolCalls: [], ...extra }
}

function reads(msgId: string, n: number, status: ToolCall['status'] = 'done'): ToolCall[] {
  return Array.from({ length: n }, (_unused, i) => tc(`${msgId}-${String(i)}`, 'read_file', status))
}

describe('tool-display: cross-message runs', () => {
  it('renders a single-message run exactly as the per-message rollup', () => {
    const run = deriveToolRuns([assistant('a1', { toolCalls: reads('a1', 3) })])[0]
    assert.ok(run)
    assert.deepEqual(
      buildToolRunDisplayItems(run),
      buildToolCallDisplayItems(run.toolCalls),
      'a one-step run must not add a nesting level',
    )
  })

  it('keeps one flat list when more messages join the run', () => {
    const run = deriveToolRuns([
      assistant('a1', { content: 'On it.', toolCalls: reads('a1', 2) }),
      assistant('a2', { toolCalls: reads('a2', 3) }),
      assistant('a3', { toolCalls: reads('a3', 1) }),
    ])[0]
    assert.ok(run)
    const items = buildToolRunDisplayItems(run)
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].key, RUN_ROLLUP_KEY)
    assert.equal(items[0].label, 'Used 6 tools')
    assert.deepEqual(
      items[0].children.map((child) => child.type === 'individual' && child.toolCall.id),
      ['a1-0', 'a1-1', 'a2-0', 'a2-1', 'a2-2', 'a3-0'],
    )
  })
  it('leads with the run polish and trails the counts and failures', () => {
    const run = deriveToolRuns([
      assistant('a1', {
        toolCalls: reads('a1', 2),
        runSummary: 'Checked CI, branch state, and test coverage',
      }),
      assistant('a2', { toolCalls: [...reads('a2', 1), tc('a2-err', 'read_file', 'error')] }),
    ])[0]
    assert.ok(run)

    const items = buildToolRunDisplayItems(run)
    assert.equal(items[0]?.type, 'rollup')
    assert.equal(items[0].label, 'Checked CI, branch state, and test coverage · 4 tools · 1 failed')
  })

  it('stays progressive while any member is still running', () => {
    const run = deriveToolRuns([
      assistant('a1', { toolCalls: reads('a1', 2) }),
      assistant('a2', { toolCalls: reads('a2', 1, 'running') }),
    ])[0]
    assert.ok(run)
    assert.equal(buildToolRunDisplayItems(run)[0]?.label, 'Using 3 tools')
  })

  it('keeps failures outside a run even when member messages have polished summaries', () => {
    const run = deriveToolRuns([
      assistant('a1', {
        toolCalls: [...reads('a1', 2), tc('failed', 'read_file', 'error')],
        toolSummary: 'Inspected the repo layout',
      }),
      assistant('a2', { toolCalls: reads('a2', 2), reasoning: 'Nearly there.' }),
    ])[0]
    assert.ok(run)
    const items = buildToolRunDisplayItems(run)
    assert.equal(items[0]?.label, 'Used 5 tools · 1 failed')
    assert.equal(items[1]?.type, 'individual')
    assert.equal(items[1].toolCall.id, 'failed')
    assert.equal(rollupChildren(items).length, 4)
  })
  it('does not add a tool wrapper for a reasoning-only member', () => {
    const run = deriveToolRuns([
      assistant('a1', { toolCalls: reads('a1', 2) }),
      assistant('a2', { reasoning: 'Weighing the next move.' }),
      assistant('a3', { toolCalls: reads('a3', 2) }),
    ])[0]
    assert.ok(run)
    const children = rollupChildren(buildToolRunDisplayItems(run))
    assert.equal(children.length, 4)
    assert.ok(children.every((child) => child.type === 'individual'))
  })
  it('leaves a message’s subagent cards for that message to render', () => {
    const explore: ToolCall = {
      ...tc('sub-1', 'task'),
      subagent: {
        id: 'sub-1',
        kind: 'explore',
        status: 'done',
        prompt: 'look around',
        summary: 'done',
        messages: [],
      },
    }
    const items = buildSubagentDisplayItems([tc('r1', 'read_file'), explore])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'individual')
    assert.equal(items[0].toolCall.id, 'sub-1')
  })
})
