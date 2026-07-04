import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTabVisibleForScope, planScope, tabsForScope } from './scoped-tabs.ts'

interface Tab {
  id: string
  scopeId: string | null
}

function tabs(): Tab[] {
  return [
    { id: 'a1', scopeId: 'A' },
    { id: 'b1', scopeId: 'B' },
    { id: 'a2', scopeId: 'A' },
    { id: 'b2', scopeId: 'B' },
  ]
}

test('tabsForScope returns only the matching scope tabs in order', () => {
  assert.deepEqual(
    tabsForScope(tabs(), 'A').map((t) => t.id),
    ['a1', 'a2'],
  )
})

test('isTabVisibleForScope matches the active scope', () => {
  assert.equal(isTabVisibleForScope({ scopeId: 'A' }, 'A'), true)
  assert.equal(isTabVisibleForScope({ scopeId: 'A' }, 'B'), false)
})

test('planScope splits visible vs hidden for the active scope', () => {
  const plan = planScope(tabs(), 'B')
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

test('planScope flags needsNew when the active scope has no tabs', () => {
  const plan = planScope(tabs(), 'C')
  assert.equal(plan.visible.length, 0)
  assert.equal(plan.hidden.length, 4)
  assert.equal(plan.needsNew, true)
})

test('planScope does not request a new tab when no scope is active', () => {
  const plan = planScope([], null)
  assert.equal(plan.needsNew, false)
})
