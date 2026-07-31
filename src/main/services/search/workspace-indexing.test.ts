import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { getWorkspaceIndexStatus, resetWorkspaceIndexStatusForTest } from './index-status.ts'
import { invalidateIndex } from './file-index.ts'
import {
  semanticIndexAllowed,
  semanticIndexPending,
  watchIndexAllowed,
} from './workspace-index-gate.ts'
import {
  resetWorkspaceIndexingForTest,
  setWorkspaceIndexPolicyOverrideForTest,
  startWorkspaceIndexing,
} from './workspace-indexing.ts'
import { stopWorkspaceIndexWatcher } from './workspace-index-watcher.ts'
import { setSemanticBackendForTest } from './semantic-index.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('workspace-indexing scale gate (#795)', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  afterEach(async () => {
    stopWorkspaceIndexWatcher()
    resetWorkspaceIndexingForTest()
    resetWorkspaceIndexStatusForTest()
    setSemanticBackendForTest(null)
    invalidateIndex()
    restoreWorkspace?.()
    restoreWorkspace = undefined
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  async function prepWorkspace(): Promise<string> {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-ws-index-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await mkdir(join(tempRoot, 'src'), { recursive: true })
    await writeFile(join(tempRoot, 'src', 'main.ts'), 'export {}\n', 'utf-8')
    return tempRoot
  }

  it('marks the gate pending until file-index scale evidence is ready, then allows ordinary repos', async () => {
    const root = await prepWorkspace()
    // No semantic backend — we only assert gate sequencing, not gortex spawn.
    setSemanticBackendForTest(null)
    startWorkspaceIndexing(root)
    assert.equal(semanticIndexPending(root), true)
    await waitFor(() => !semanticIndexPending(root))
    assert.equal(semanticIndexAllowed(root), true)
    assert.equal(watchIndexAllowed(root), true)
  })

  it('skips semantic indexing and watching when the policy override is never', async () => {
    const root = await prepWorkspace()
    setSemanticBackendForTest(null)
    setWorkspaceIndexPolicyOverrideForTest('never')
    startWorkspaceIndexing(root)
    await waitFor(() => getWorkspaceIndexStatus().semantic.phase === 'skipped')
    assert.equal(getWorkspaceIndexStatus().semantic.phase, 'skipped')
    assert.match(
      getWorkspaceIndexStatus().semantic.reason ?? '',
      /Override disables semantic indexing/,
    )
    assert.equal(semanticIndexAllowed(root), false)
    assert.equal(watchIndexAllowed(root), false)
  })
})
