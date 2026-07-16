// Level-2 declarative panel — data model + todo seed (P2).
//
// Pins the invariants that make the level-2 panel "one adapter away from
// rendering in other ACP clients" (plan: Feature packs → UI levels): a list
// panel is ACP-`plan`-shaped, the todo mapping is lossless for the fields the
// renderer draws, and the summary matches what the existing todo panel shows.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TodoItem } from '../wire-types.ts'
import {
  panelListSummary,
  todosToPanelListData,
  todosToPanelListRows,
  type PanelEntry,
} from './pack-panel.ts'

describe('todosToPanelListRows (data-model seed)', () => {
  it('maps id / content → label / status losslessly', () => {
    const todos: TodoItem[] = [
      { id: 't1', content: 'read the code', status: 'completed' },
      { id: 't2', content: 'fix the bug', status: 'in_progress' },
      { id: 't3', content: 'ship it', status: 'pending' },
    ]
    assert.deepEqual(todosToPanelListRows(todos), [
      { id: 't1', label: 'read the code', status: 'completed' },
      { id: 't2', label: 'fix the bug', status: 'in_progress' },
      { id: 't3', label: 'ship it', status: 'pending' },
    ])
  })

  it('omits cancelled entries to preserve the existing plan-panel behavior', () => {
    const todos: TodoItem[] = [
      { id: 't1', content: 'obsoleted', status: 'cancelled' },
      { id: 't2', content: 'active', status: 'in_progress' },
    ]
    const rows = todosToPanelListRows(todos)
    assert.deepEqual(
      rows.map((r) => r.status),
      ['in_progress'],
    )
  })

  it('projects assigned-model + check into badges', () => {
    const todos: TodoItem[] = [
      {
        id: 't1',
        content: 'run locally',
        status: 'pending',
        assignedModel: 'local',
        check: { kind: 'shell', command: 'npm test' },
      },
    ]
    const rows = todosToPanelListRows(todos)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0]?.badges, [
      { kind: 'assigned-model', label: 'local' },
      { kind: 'check', label: 'shell' },
    ])
  })

  it('omits the badges field entirely when there are none', () => {
    // Keeps `panel_update` payloads small and diff-friendly for renderers that
    // key off "badges present at all" rather than "badges is a non-empty array".
    const rows = todosToPanelListRows([{ id: 't1', content: 'plain', status: 'pending' }])
    const [row] = rows
    assert.ok(row, 'expected one row')
    assert.equal(Object.hasOwn(row, 'badges'), false)
  })
})

describe('panelListSummary', () => {
  it('counts completed vs total, ignoring cancelled (matches todoProgress)', () => {
    const rows: PanelEntry[] = [
      { id: '1', label: 'a', status: 'completed' },
      { id: '2', label: 'b', status: 'in_progress' },
      { id: '3', label: 'c', status: 'cancelled' },
      { id: '4', label: 'd', status: 'pending' },
    ]
    assert.equal(panelListSummary(rows), '1/3 done')
  })

  it('renders as 0/0 for an empty panel', () => {
    assert.equal(panelListSummary([]), '0/0 done')
  })
})

describe('todosToPanelListData (full projection)', () => {
  it('wraps rows with a title + N/M-done summary', () => {
    const data = todosToPanelListData(
      [
        { id: 't1', content: 'a', status: 'completed' },
        { id: 't2', content: 'b', status: 'in_progress' },
      ],
      'To-dos',
    )
    assert.equal(data.kind, 'list')
    assert.equal(data.title, 'To-dos')
    assert.equal(data.summary, '1/2 done')
    assert.deepEqual(
      data.rows.map((r) => r.id),
      ['t1', 't2'],
    )
  })

  it('projects an all-cancelled plan to no visible rows', () => {
    const data = todosToPanelListData([
      { id: 't1', content: 'obsolete', status: 'cancelled' },
      { id: 't2', content: 'also obsolete', status: 'cancelled' },
    ])
    assert.deepEqual(data.rows, [])
    assert.equal(data.summary, '0/0 done')
  })
})
