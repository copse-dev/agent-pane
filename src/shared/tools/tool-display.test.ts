import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '@shared/types'
import {
  buildToolCallDisplayItems,
  getToolDisplayName,
  aggregateToolStatus,
} from './tool-display.ts'

function tc(
  id: string,
  name: string,
  status: ToolCall['status'] = 'done',
): ToolCall {
  return { id, name, args: {}, status, result: status === 'running' ? null : 'ok' }
}

describe('tool-display', () => {
  it('maps known tools to human-readable names', () => {
    assert.equal(getToolDisplayName('read_file'), 'Read file')
    assert.equal(getToolDisplayName('list_dir'), 'List directory')
    assert.equal(getToolDisplayName('run_shell'), 'Run command')
  })

  it('formats unknown tools from snake_case', () => {
    assert.equal(getToolDisplayName('custom_tool_name'), 'Custom Tool Name')
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
    const items = buildToolCallDisplayItems([tc('1', 'git_status'), tc('2', 'git_diff')])
    assert.equal(items.length, 1)
    assert.equal(items[0]?.type, 'group')
    if (items[0]?.type === 'group') assert.equal(items[0].label, 'Git')
  })

  it('does not group unrelated tools', () => {
    const items = buildToolCallDisplayItems([tc('1', 'read_file'), tc('2', 'search_code')])
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
