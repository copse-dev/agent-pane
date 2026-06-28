import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isMockGhEnabled,
  mockGetGhPrDetails,
  mockGhCliStatus,
  mockListMyOpenPrs,
  MOCK_GH_PR_NUMBER,
  MOCK_GH_PR_OWNER,
  MOCK_GH_PR_REPO,
} from './gh-pr-mock.ts'
import { getGhCliStatus, getGhPrDetails, listMyOpenPrs } from './gh-pr-service.ts'

describe('gh-pr-mock', () => {
  it('returns deterministic PR fixtures', () => {
    const prs = mockListMyOpenPrs()
    assert.equal(prs.length, 2)
    assert.equal(prs[0]?.number, MOCK_GH_PR_NUMBER)

    const details = mockGetGhPrDetails({
      owner: MOCK_GH_PR_OWNER,
      repo: MOCK_GH_PR_REPO,
      number: MOCK_GH_PR_NUMBER,
    })
    assert.ok(details?.body.includes('PRs'))
    assert.equal(details?.files.length, 4)
  })

  it('supports unavailable and unauthenticated status modes', () => {
    process.env['COPSE_PANEL_MOCK_GH'] = '1'
    process.env['COPSE_PANEL_MOCK_GH_STATUS'] = 'unavailable'
    assert.equal(mockGhCliStatus().installed, false)

    process.env['COPSE_PANEL_MOCK_GH_STATUS'] = 'unauthenticated'
    assert.equal(mockGhCliStatus().authenticated, false)

    process.env['COPSE_PANEL_MOCK_GH_STATUS'] = 'ready'
    assert.equal(mockGhCliStatus().username, 'mock-user')
    delete process.env['COPSE_PANEL_MOCK_GH']
    delete process.env['COPSE_PANEL_MOCK_GH_STATUS']
  })
})

describe('gh-pr-service mock wiring', () => {
  it('delegates to mock fixtures when COPSE_PANEL_MOCK_GH=1', async () => {
    process.env['COPSE_PANEL_MOCK_GH'] = '1'
    process.env['COPSE_PANEL_MOCK_GH_STATUS'] = 'ready'
    assert.equal(isMockGhEnabled(), true)

    const status = await getGhCliStatus()
    assert.equal(status.username, 'mock-user')

    const prs = await listMyOpenPrs()
    assert.ok(prs && prs.length >= 2)

    const details = await getGhPrDetails({
      owner: MOCK_GH_PR_OWNER,
      repo: MOCK_GH_PR_REPO,
      number: MOCK_GH_PR_NUMBER,
    })
    assert.equal(details?.title, 'Add GitHub PR panel tab')

    delete process.env['COPSE_PANEL_MOCK_GH']
    delete process.env['COPSE_PANEL_MOCK_GH_STATUS']
  })
})
