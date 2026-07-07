import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getWorkspaceIndexStatus,
  indexBuildStarted,
  indexBuildFinished,
  onWorkspaceIndexStatusChanged,
  resetWorkspaceIndexStatusForTest,
  setSemanticIndexUnavailable,
} from './index-status.ts'

describe('index-status', () => {
  beforeEach(() => {
    resetWorkspaceIndexStatusForTest()
  })

  it('starts idle for both components', () => {
    const status = getWorkspaceIndexStatus()
    assert.equal(status.fileIndex.phase, 'idle')
    assert.equal(status.semantic.phase, 'idle')
  })

  it('tracks a build through building → ready with a start timestamp', () => {
    indexBuildStarted('fileIndex')
    const building = getWorkspaceIndexStatus().fileIndex
    assert.equal(building.phase, 'building')
    assert.ok(typeof building.startedAt === 'number' && building.startedAt > 0)

    indexBuildFinished('fileIndex', true)
    const done = getWorkspaceIndexStatus().fileIndex
    assert.equal(done.phase, 'ready')
    assert.equal(done.startedAt, undefined)
  })

  it('stays building while overlapping builds are in flight', () => {
    indexBuildStarted('semantic')
    indexBuildStarted('semantic')
    indexBuildFinished('semantic', true)
    assert.equal(getWorkspaceIndexStatus().semantic.phase, 'building')
    indexBuildFinished('semantic', true)
    assert.equal(getWorkspaceIndexStatus().semantic.phase, 'ready')
  })

  it('keeps the first start timestamp across overlapping builds', () => {
    indexBuildStarted('fileIndex')
    const first = getWorkspaceIndexStatus().fileIndex.startedAt
    indexBuildStarted('fileIndex')
    assert.equal(getWorkspaceIndexStatus().fileIndex.startedAt, first)
  })

  it('reports error when the last finished build failed, and recovers on success', () => {
    indexBuildStarted('fileIndex')
    indexBuildFinished('fileIndex', false)
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'error')

    indexBuildStarted('fileIndex')
    indexBuildFinished('fileIndex', true)
    assert.equal(getWorkspaceIndexStatus().fileIndex.phase, 'ready')
  })

  it('marks the semantic component unavailable without touching the file index', () => {
    setSemanticIndexUnavailable()
    const status = getWorkspaceIndexStatus()
    assert.equal(status.semantic.phase, 'unavailable')
    assert.equal(status.fileIndex.phase, 'idle')
  })

  it('notifies listeners on every transition until unsubscribed', () => {
    const phases: string[] = []
    const off = onWorkspaceIndexStatusChanged((status) => phases.push(status.fileIndex.phase))
    indexBuildStarted('fileIndex')
    indexBuildFinished('fileIndex', true)
    off()
    indexBuildStarted('fileIndex')
    assert.deepEqual(phases, ['building', 'ready'])
  })
})
