import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { projectStoreDir, workspaceRoot } from './copse-paths.ts'

const STORE_ROOT = join(tmpdir(), 'copse-store')

describe('workspaceRoot', () => {
  it('honors COPSE_WORKSPACE_DIR for callers that list the store root', () => {
    const previous = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = STORE_ROOT
    try {
      assert.equal(workspaceRoot(), STORE_ROOT)
    } finally {
      if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previous
    }
  })
})

describe('projectStoreDir', () => {
  it('resolves a project beneath the configured workspace store', () => {
    const previous = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = STORE_ROOT
    try {
      assert.equal(projectStoreDir('project-1'), resolve(STORE_ROOT, 'project-1'))
    } finally {
      if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previous
    }
  })

  it('rejects traversal, absolute, and empty project ids', () => {
    const previous = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = STORE_ROOT
    try {
      for (const projectId of ['../target', resolve(STORE_ROOT, '..', 'outside'), '']) {
        assert.throws(() => projectStoreDir(projectId), /outside the workspace store/)
      }
    } finally {
      if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previous
    }
  })
})
