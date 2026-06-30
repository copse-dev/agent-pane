import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTabVisibleForProject, planProjectScope, tabsForProject } from './project-scoped-tabs.ts'

interface Tab {
  id: string
  projectId: string | null
}

function tabs(): Tab[] {
  return [
    { id: 'a1', projectId: 'A' },
    { id: 'b1', projectId: 'B' },
    { id: 'a2', projectId: 'A' },
    { id: 'b2', projectId: 'B' },
  ]
}

test('tabsForProject returns only the matching project tabs in order', () => {
  assert.deepEqual(
    tabsForProject(tabs(), 'A').map((t) => t.id),
    ['a1', 'a2'],
  )
})

test('isTabVisibleForProject matches the active project', () => {
  assert.equal(isTabVisibleForProject({ projectId: 'A' }, 'A'), true)
  assert.equal(isTabVisibleForProject({ projectId: 'A' }, 'B'), false)
})

test('planProjectScope splits visible vs hidden for the active project', () => {
  const plan = planProjectScope(tabs(), 'B')
  assert.deepEqual(
    plan.visible.map((t) => t.id),
    ['b1', 'b2'],
  )
  assert.deepEqual(
    plan.hidden.map((t) => t.id),
    ['a1', 'a2'],
  )
  assert.equal(plan.needsNew, false)
})

test('planProjectScope flags needsNew when the active project has no tabs', () => {
  const plan = planProjectScope(tabs(), 'C')
  assert.equal(plan.visible.length, 0)
  assert.equal(plan.hidden.length, 4)
  assert.equal(plan.needsNew, true)
})

test('planProjectScope does not request a new tab when no project is active', () => {
  const plan = planProjectScope([], null)
  assert.equal(plan.needsNew, false)
})
