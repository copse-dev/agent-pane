import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  todosToPanelListData,
  type PanelListData,
  type PanelTreeData,
} from '@copse/agent/packs/pack-panel.ts'
import { qsRequired } from '../dom/helpers.ts'
import { createPackPanelEl } from './pack-panel.ts'

// Component tests for the generic level-2 declarative panel renderer (P2).
// Two invariants matter for reviewers:
//  1. The renderer is *generic* — feed it a list panel and it renders a list;
//     feed it a tree and it renders nested rows. No pack-specific paths.
//  2. It matches the todo panel's visible shape (header + rows + status), so
//     the P4 todos pack can drop `panel_update` onto this seam without a
//     pixel-visible regression.

describe('createPackPanelEl (list)', () => {
  it('renders a list panel with a header, summary, and one row per entry', () => {
    const data: PanelListData = {
      kind: 'list',
      title: 'To-dos',
      summary: '1/2 done',
      rows: [
        { id: 't1', label: 'read the code', status: 'completed' },
        { id: 't2', label: 'fix the bug', status: 'in_progress' },
      ],
    }

    const panel = createPackPanelEl(data, {
      packId: 'copse.todos',
      contributionId: 'todos-panel',
    })

    assert.equal(panel.getAttribute('data-panel-kind'), 'list')
    assert.equal(panel.getAttribute('data-pack-id'), 'copse.todos')
    assert.equal(panel.getAttribute('data-contribution-id'), 'todos-panel')
    assert.equal(panel.getAttribute('aria-label'), 'To-dos')
    assert.equal(qsRequired(panel, '.pack-panel-title').textContent, 'To-dos')
    assert.equal(qsRequired(panel, '.pack-panel-summary').textContent, '1/2 done')

    const rows = Array.from(panel.querySelectorAll<HTMLElement>('.pack-panel-row'))
    assert.equal(rows.length, 2)
    const [first, second] = rows
    assert.ok(first && second, 'expected two rendered rows')
    assert.equal(first.getAttribute('data-row-id'), 't1')
    assert.equal(first.getAttribute('data-status'), 'completed')
    assert.equal(first.classList.contains('pack-panel-row-completed'), true)
    assert.equal(qsRequired(first, '.pack-panel-row-label').textContent, 'read the code')
    assert.equal(second.getAttribute('data-status'), 'in_progress')
  })

  it('renders each badge with its kind class + label', () => {
    const data: PanelListData = {
      kind: 'list',
      rows: [
        {
          id: 't1',
          label: 'run locally',
          status: 'pending',
          badges: [
            { kind: 'assigned-model', label: 'local' },
            { kind: 'check', label: 'shell' },
          ],
        },
      ],
    }
    const panel = createPackPanelEl(data)
    const badges = Array.from(panel.querySelectorAll<HTMLElement>('.pack-panel-badge'))
    assert.equal(badges.length, 2)
    const [assignedModel, check] = badges
    assert.ok(assignedModel && check, 'expected both badges to render')
    assert.equal(assignedModel.getAttribute('data-badge-kind'), 'assigned-model')
    assert.equal(assignedModel.textContent, 'local')
    assert.equal(check.getAttribute('data-badge-kind'), 'check')
    assert.equal(check.textContent, 'shell')
  })

  it('omits the header entirely when neither title nor summary is set', () => {
    const data: PanelListData = {
      kind: 'list',
      rows: [{ id: 't1', label: 'only row', status: 'pending' }],
    }
    const panel = createPackPanelEl(data)
    assert.equal(panel.querySelector('.pack-panel-header'), null)
  })

  it('lands the same shape a P4 todos pack would emit via `panel_update`', () => {
    // The seed transform (`todosToPanelListData`) is the concrete "one adapter
    // away" claim in the plan: feeding it a `TodoItem[]` and rendering the
    // result yields the same header + rows the current todo panel shows.
    const data = todosToPanelListData(
      [
        { id: 't1', content: 'plan the work', status: 'completed' },
        {
          id: 't2',
          content: 'run it',
          status: 'in_progress',
          assignedModel: 'local',
        },
      ],
      'To-dos',
    )
    const panel = createPackPanelEl(data)
    assert.equal(qsRequired(panel, '.pack-panel-title').textContent, 'To-dos')
    assert.equal(qsRequired(panel, '.pack-panel-summary').textContent, '1/2 done')
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('.pack-panel-row'))
    assert.equal(rows.length, 2)
    const secondRow = rows[1]
    assert.ok(secondRow, 'expected the second row')
    assert.equal(qsRequired(secondRow, '.pack-panel-badge-assigned-model').textContent, 'local')
  })

  it('leaves the list unclamped when there are 5 rows or fewer', () => {
    const data: PanelListData = {
      kind: 'list',
      rows: Array.from({ length: 5 }, (_, i) => ({
        id: `t${String(i)}`,
        label: `row ${String(i)}`,
        status: 'pending' as const,
      })),
    }
    const panel = createPackPanelEl(data)
    const list = qsRequired(panel, '.pack-panel-list')
    assert.equal(list.style.maxHeight, '')
    assert.equal(list.style.overflowY, '')
  })

  it('clamps the list to exactly 5 rows of measured height once there are more', () => {
    const ROW_HEIGHT = 20
    // eslint-disable-next-line @typescript-eslint/unbound-method -- saved only to restore the prototype afterward, never called unbound
    const patchedRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.classList.contains('pack-panel-row')) {
        const index = Array.from(this.parentElement?.children ?? []).indexOf(this)
        return new DOMRect(0, index * ROW_HEIGHT, 300, ROW_HEIGHT)
      }
      return new DOMRect(0, 0, 300, 0)
    }
    try {
      const data: PanelListData = {
        kind: 'list',
        rows: Array.from({ length: 8 }, (_, i) => ({
          id: `t${String(i)}`,
          label: `row ${String(i)}`,
          status: 'pending' as const,
        })),
      }
      const panel = createPackPanelEl(data)
      const list = qsRequired(panel, '.pack-panel-list')
      // Row heights vary with wrapped labels, so the cap is measured (top of the
      // 6th row) rather than a fixed pixel guess — here that's 5 * ROW_HEIGHT.
      assert.equal(list.style.maxHeight, `${String(5 * ROW_HEIGHT)}px`)
      assert.equal(list.style.overflowY, 'auto')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = patchedRect
    }
  })

  it('omits cancelled todos and computes progress from visible rows', () => {
    const data = todosToPanelListData([
      { id: 'done', content: 'Done step', status: 'completed' },
      { id: 'cancelled', content: 'Skipped', status: 'cancelled' },
      { id: 'open', content: 'Still open', status: 'pending' },
    ])
    const panel = createPackPanelEl(data)
    assert.equal(qsRequired(panel, '.pack-panel-summary').textContent, '1/2 done')
    assert.equal(panel.querySelectorAll('.pack-panel-row').length, 2)
    assert.equal(panel.querySelector('[data-row-id="cancelled"]'), null)
    assert.ok(panel.querySelector('[data-row-id="done"]'))
    assert.ok(panel.querySelector('[data-row-id="open"]'))
  })
})

describe('createPackPanelEl (tree)', () => {
  it('renders nested tree nodes with roles set for a11y', () => {
    const data: PanelTreeData = {
      kind: 'tree',
      title: 'Sources',
      roots: [
        {
          id: 'root',
          label: 'workspace',
          status: 'completed',
          children: [
            { id: 'child-a', label: 'a.ts', status: 'completed' },
            {
              id: 'child-b',
              label: 'b/',
              status: 'in_progress',
              children: [{ id: 'grandchild', label: 'b/c.ts', status: 'pending' }],
            },
          ],
        },
      ],
    }
    const panel = createPackPanelEl(data)
    assert.equal(panel.getAttribute('role'), 'tree')

    const topNodes = panel.querySelectorAll(':scope > .pack-panel-tree > .pack-panel-tree-node')
    assert.equal(topNodes.length, 1)

    const allNodes = Array.from(panel.querySelectorAll<HTMLElement>('.pack-panel-tree-node'))
    assert.equal(allNodes.length, 4)
    const ids = allNodes.map((n) => n.getAttribute('data-row-id'))
    assert.deepEqual(ids, ['root', 'child-a', 'child-b', 'grandchild'])
  })
})
