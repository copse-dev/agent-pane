import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cachingGitHubBackend,
  invalidateGitHubReadCache,
  resetGitHubReadCacheForTest,
} from './github-read-cache.ts'
import type { GitHubBackend, PrRef } from './backend.ts'
import type {
  GhCliStatus,
  GhIssueSummary,
  GhPrChecksState,
  GhPrDetails,
  GhPrFileDiff,
  PrActionResult,
} from '@shared/types/git.ts'

const REF: PrRef = { owner: 'octo', repo: 'demo', number: 7 }

const status: GhCliStatus = {
  installed: true,
  authenticated: true,
  username: 'octo',
  message: null,
}

function emptyBackend(calls: { status: number; details: number; approve: number }): GitHubBackend {
  const ok: PrActionResult = { ok: true, backend: 'api', message: 'ok' }
  return {
    kind: 'api',
    getStatus: async (): Promise<GhCliStatus> => {
      calls.status++
      return status
    },
    listMyOpenPrs: async () => [],
    listWorkspaceOpenPrs: async () => [],
    getPrDetails: async (): Promise<GhPrDetails> => {
      calls.details++
      const details: GhPrDetails = {
        owner: REF.owner,
        repo: REF.repo,
        number: REF.number,
        title: 'T',
        url: 'https://github.com/octo/demo/pull/7',
        state: 'OPEN',
        body: '',
        files: [],
      }
      return details
    },
    getPrFileDiff: async (): Promise<GhPrFileDiff | null> => null,
    getPrChecksState: async (): Promise<GhPrChecksState> => 'success',
    listWorkspaceOpenIssues: async () => ({ issues: [], hasMore: false }),
    getIssue: async (): Promise<GhIssueSummary | null> => null,
    searchWorkspaceIssues: async () => [],
    createPr: async () => ok,
    rerunFailedRuns: async () => ok,
    approvePr: async (): Promise<PrActionResult> => {
      calls.approve++
      return ok
    },
    markPrReady: async () => ok,
    enableAutoMerge: async () => ok,
  }
}

afterEach((): void => {
  resetGitHubReadCacheForTest()
})

describe('cachingGitHubBackend', () => {
  it('serves a second status read from cache', async () => {
    const calls = { status: 0, details: 0, approve: 0 }
    const backend = cachingGitHubBackend(emptyBackend(calls))
    await backend.getStatus()
    await backend.getStatus()
    assert.equal(calls.status, 1)
  })

  it('refetches after invalidateGitHubReadCache', async () => {
    const calls = { status: 0, details: 0, approve: 0 }
    const backend = cachingGitHubBackend(emptyBackend(calls))
    await backend.getStatus()
    invalidateGitHubReadCache()
    await backend.getStatus()
    assert.equal(calls.status, 2)
  })

  it('refetches when the refresh lands while a read is in flight', async () => {
    // `clear` used to drop only the stored entry, so a refresh during a read was
    // handed that same pre-refresh promise — and its answer then filled the slot
    // for the whole 60s TTL, with GitHub never asked again.
    const calls = { status: 0, details: 0, approve: 0 }
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = emptyBackend(calls)
    const backend = cachingGitHubBackend({
      ...inner,
      getStatus: async (): Promise<GhCliStatus> => {
        calls.status++
        if (calls.status === 1) await gate
        return status
      },
    })

    const inFlight = backend.getStatus()
    await Promise.resolve()
    invalidateGitHubReadCache()

    const afterRefresh = backend.getStatus()
    release()
    await Promise.all([inFlight, afterRefresh])

    assert.equal(calls.status, 2, 'the refresh must issue its own read')
    // And the first read's late answer must not have re-filled the cleared slot.
    await backend.getStatus()
    assert.equal(calls.status, 2, 'the refreshed value is what stays cached')
  })

  it('drops PR details after a write', async () => {
    const calls = { status: 0, details: 0, approve: 0 }
    const backend = cachingGitHubBackend(emptyBackend(calls))
    await backend.getPrDetails(REF)
    await backend.getPrDetails(REF)
    assert.equal(calls.details, 1)
    await backend.approvePr(REF)
    await backend.getPrDetails(REF)
    assert.equal(calls.details, 2)
    assert.equal(calls.approve, 1)
  })
})
