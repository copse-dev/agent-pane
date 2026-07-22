import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  NESTED_REPO_BYTE_CAP,
  NESTED_REPO_PATH_CAP,
  WORKSPACE_INDEX_BYTE_CAP,
  WORKSPACE_INDEX_PATH_CAP,
  decideWorkspaceIndexPolicy,
  policyAllowsSemantic,
  policyAllowsWatch,
  type WorkspaceIndexPolicyInput,
} from './workspace-index-policy.ts'

function base(over: Partial<WorkspaceIndexPolicyInput> = {}): WorkspaceIndexPolicyInput {
  return {
    pathCount: 1_200,
    byteEstimate: 12_000_000,
    nestedRepos: [],
    override: 'default',
    discoveryConfidence: 'complete',
    ...over,
  }
}

describe('decideWorkspaceIndexPolicy', () => {
  it('allows full indexing for ordinary repositories', () => {
    const policy = decideWorkspaceIndexPolicy(base())
    assert.equal(policy.semantic, 'full')
    assert.equal(policy.watch, 'full')
    assert.deepEqual(policy.reasons, [])
    assert.deepEqual(policy.suggestedExcludes, [])
    assert.equal(policyAllowsSemantic(policy), true)
    assert.equal(policyAllowsWatch(policy), true)
  })

  it('skips semantic and watch above the global path cap', () => {
    const policy = decideWorkspaceIndexPolicy(
      base({ pathCount: WORKSPACE_INDEX_PATH_CAP, byteEstimate: null }),
    )
    assert.equal(policy.semantic, 'skipped')
    assert.equal(policy.watch, 'skipped')
    assert.ok(policy.reasons.some((r) => /indexed paths/.test(r)))
    assert.equal(policyAllowsSemantic(policy), false)
    assert.equal(policyAllowsWatch(policy), false)
  })

  it('skips when the byte estimate alone exceeds the global cap', () => {
    const policy = decideWorkspaceIndexPolicy(
      base({ pathCount: 10, byteEstimate: WORKSPACE_INDEX_BYTE_CAP }),
    )
    assert.equal(policy.semantic, 'skipped')
    assert.equal(policy.watch, 'skipped')
    assert.ok(policy.reasons.some((r) => /bytes/.test(r)))
  })

  it('limits work and suggests excludes for oversized nested child repos only', () => {
    const policy = decideWorkspaceIndexPolicy(
      base({
        pathCount: 60_000,
        nestedRepos: [
          { relativePath: '', trackedPathCount: 8_000, trackedByteEstimate: null },
          {
            relativePath: 'vendor/wpt',
            trackedPathCount: NESTED_REPO_PATH_CAP,
            trackedByteEstimate: null,
          },
          {
            relativePath: 'third_party/huge',
            trackedPathCount: 1_000,
            trackedByteEstimate: NESTED_REPO_BYTE_CAP,
          },
        ],
      }),
    )
    assert.equal(policy.semantic, 'limited')
    assert.equal(policy.watch, 'limited')
    assert.deepEqual(policy.suggestedExcludes, ['vendor/wpt/', 'third_party/huge/'])
    assert.ok(policy.reasons.some((r) => r.includes('vendor/wpt')))
    assert.ok(!policy.suggestedExcludes.includes('/'))
    assert.ok(!policy.suggestedExcludes.includes(''))
  })

  it('never excludes the selected root even when the root observation is huge', () => {
    const policy = decideWorkspaceIndexPolicy(
      base({
        pathCount: 40_000,
        nestedRepos: [
          {
            relativePath: '',
            trackedPathCount: NESTED_REPO_PATH_CAP * 3,
            trackedByteEstimate: NESTED_REPO_BYTE_CAP * 3,
          },
        ],
      }),
    )
    assert.equal(policy.semantic, 'full')
    assert.deepEqual(policy.suggestedExcludes, [])
  })

  it('prefers the hard global skip over nested limited when both fire', () => {
    const policy = decideWorkspaceIndexPolicy(
      base({
        pathCount: WORKSPACE_INDEX_PATH_CAP + 1,
        nestedRepos: [
          {
            relativePath: 'vendor/wpt',
            trackedPathCount: NESTED_REPO_PATH_CAP,
            trackedByteEstimate: null,
          },
        ],
      }),
    )
    assert.equal(policy.semantic, 'skipped')
    assert.equal(policy.watch, 'skipped')
    assert.deepEqual(policy.suggestedExcludes, [])
  })

  it('honors force and never overrides', () => {
    const forced = decideWorkspaceIndexPolicy(
      base({ pathCount: WORKSPACE_INDEX_PATH_CAP * 2, override: 'force' }),
    )
    assert.equal(forced.semantic, 'full')
    assert.equal(forced.watch, 'full')

    const never = decideWorkspaceIndexPolicy(base({ pathCount: 10, override: 'never' }))
    assert.equal(never.semantic, 'skipped')
    assert.equal(never.watch, 'skipped')
  })

  it('keeps incomplete discovery under the global cap rather than inventing a skip', () => {
    const policy = decideWorkspaceIndexPolicy(
      base({
        pathCount: 500,
        byteEstimate: null,
        discoveryConfidence: 'failed',
      }),
    )
    assert.equal(policy.semantic, 'full')
    assert.equal(policy.watch, 'full')
  })

  it('notes incomplete discovery when the global cap still fires', () => {
    const policy = decideWorkspaceIndexPolicy(
      base({
        pathCount: WORKSPACE_INDEX_PATH_CAP,
        discoveryConfidence: 'partial',
      }),
    )
    assert.equal(policy.semantic, 'skipped')
    assert.ok(policy.reasons.some((r) => /incomplete/.test(r)))
  })
})
