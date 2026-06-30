import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  addRoadmapItem,
  loadRoadmapItems,
  setRoadmapItemStatus,
  setRoadmapRootForTest,
} from './roadmap-plans-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('roadmap-plans-store', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roadmap-plans-'))
    setRoadmapRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setRoadmapRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it('starts empty', () => {
    assert.deepEqual(loadRoadmapItems(), [])
  })

  it('adds items with incrementing ids and ready status', () => {
    const first = addRoadmapItem({ prompt: 'Refactor the parser', notes: 'after #500 merges' })
    const second = addRoadmapItem({ prompt: 'Add a settings export' })
    assert.equal(first.id, 'r1')
    assert.equal(first.status, 'ready')
    assert.equal(first.notes, 'after #500 merges')
    assert.equal(second.id, 'r2')
    assert.equal(loadRoadmapItems().length, 2)
  })

  it('updates status by id and reports unknown ids', () => {
    const item = addRoadmapItem({ prompt: 'Do later' })
    const updated = setRoadmapItemStatus(item.id, 'blocked')
    assert.equal(updated?.status, 'blocked')
    assert.equal(at(loadRoadmapItems(), 0).status, 'blocked')
    assert.equal(setRoadmapItemStatus('r999', 'done'), null)
  })

  it('persists across loads', () => {
    addRoadmapItem({ prompt: 'Persisted item' })
    const reloaded = loadRoadmapItems()
    assert.equal(reloaded.length, 1)
    assert.equal(at(reloaded, 0).prompt, 'Persisted item')
  })
})
