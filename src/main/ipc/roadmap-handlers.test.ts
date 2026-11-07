import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { storageSet } from '../services/storage/storage.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { IpcValidationError } from './ipc-guards.ts'
import { roadmapExportProject } from './roadmap-handlers.ts'

const ALPHA = { id: 'project-a', path: '/repos/alpha', name: 'alpha' }
const BETA = { id: 'project-b', path: '/repos/beta', name: 'beta' }

beforeEach(() => {
  storageSet('projects', [ALPHA, BETA])
  storageSet('activeProjectId', ALPHA.id)
})

afterEach(() => {
  storageSet('projects', [])
  storageSet('activeProjectId', null)
})

describe('roadmapExportProject', () => {
  it('names the project whose knowledge store the notes come from', () => {
    assert.deepEqual(roadmapExportProject(), ALPHA)
    // Inside a turn the store is the turn's project, so the header must follow
    // it there rather than stay on the process-global active project.
    const inBeta = runWithThreadExecutionContext(
      {
        projectId: BETA.id,
        threadId: 'thread-1',
        projectRoot: BETA.path,
        root: BETA.path,
        checkoutMode: 'shared',
        branch: null,
      },
      roadmapExportProject,
    )
    assert.deepEqual(inBeta, BETA)
  })

  it('refuses when no project is open', () => {
    storageSet('activeProjectId', null)
    assert.throws(() => roadmapExportProject(), IpcValidationError)
  })
})
