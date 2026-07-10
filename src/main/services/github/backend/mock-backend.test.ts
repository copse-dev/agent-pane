import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mockGitHubBackend, resetMockBackendStateForTest } from './mock-backend.ts'
import { MOCK_GH_PR_NUMBER, MOCK_GH_WORKSPACE_PR_NUMBER } from '../gh-pr-mock.ts'

const REF = { owner: 'copse-dev', repo: 'copse-panel', number: MOCK_GH_PR_NUMBER }
const WORKSPACE_REF = {
  owner: 'copse-dev',
  repo: 'copse-panel',
  number: MOCK_GH_WORKSPACE_PR_NUMBER,
}

beforeEach(() => {
  process.env['COPSE_PANEL_MOCK_GH'] = '1'
  process.env['COPSE_PANEL_MOCK_GH_STATUS'] = 'ready'
  resetMockBackendStateForTest()
})

afterEach(() => {
  delete process.env['COPSE_PANEL_MOCK_GH']
  delete process.env['COPSE_PANEL_MOCK_GH_STATUS']
  delete process.env['COPSE_PANEL_MOCK_GH_ACTIONS']
  resetMockBackendStateForTest()
})

describe('mockGitHubBackend writes', () => {
  it('records an approval on the PR details', async () => {
    const result = await mockGitHubBackend.approvePr(REF)
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'mock')
    const details = await mockGitHubBackend.getPrDetails(REF)
    assert.equal(details?.reviewDecision, 'APPROVED')
  })

  it('enables auto-merge idempotently', async () => {
    const first = await mockGitHubBackend.enableAutoMerge(REF)
    assert.equal(first.strategy, 'squash')
    assert.equal(first.noop, undefined)
    assert.equal((await mockGitHubBackend.getPrDetails(REF))?.autoMergeEnabled, true)
    const second = await mockGitHubBackend.enableAutoMerge(REF)
    assert.equal(second.noop, true)
  })

  it('re-runs the seeded failed run on the workspace PR', async () => {
    const result = await mockGitHubBackend.rerunFailedRuns(WORKSPACE_REF)
    assert.equal(result.rerunCount, 1)
    // Second run finds nothing left to re-run.
    const again = await mockGitHubBackend.rerunFailedRuns(WORKSPACE_REF)
    assert.equal(again.noop, true)
    assert.equal(again.rerunCount, 0)
  })

  it('is a no-op for mark-ready unless the actions fixture seeds a draft', async () => {
    assert.equal((await mockGitHubBackend.markPrReady(REF)).noop, true)
  })

  it('transitions a seeded draft to ready under COPSE_PANEL_MOCK_GH_ACTIONS', async () => {
    process.env['COPSE_PANEL_MOCK_GH_ACTIONS'] = '1'
    resetMockBackendStateForTest()
    assert.equal((await mockGitHubBackend.getPrDetails(REF))?.isDraft, true)
    const result = await mockGitHubBackend.markPrReady(REF)
    assert.equal(result.ok, true)
    assert.equal(result.noop, undefined)
    assert.equal((await mockGitHubBackend.getPrDetails(REF))?.isDraft, false)
  })
})
