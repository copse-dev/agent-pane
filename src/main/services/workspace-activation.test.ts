import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkspaceActivation } from './workspace-activation.ts'

test('a slow SSH preparation cannot overwrite a newer project root', () => {
  const activation = new WorkspaceActivation()
  const old = activation.begin()
  const latest = activation.begin()
  latest()
  assert.throws(old, /superseded/)
  latest()
})

test('independent windows do not supersede each other', () => {
  const firstWindow = new WorkspaceActivation()
  const secondWindow = new WorkspaceActivation()
  const first = firstWindow.begin()
  secondWindow.begin()()
  first()
})
