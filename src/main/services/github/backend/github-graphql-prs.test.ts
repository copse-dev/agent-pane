import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checksFromGraphqlRollup,
  flattenGraphqlCheckRollup,
  graphqlPullToSummary,
} from './github-graphql-prs.ts'

describe('flattenGraphqlCheckRollup', () => {
  it('maps CheckRun and StatusContext nodes into the gh rollup shape', () => {
    const rollup = flattenGraphqlCheckRollup({
      state: 'SUCCESS',
      contexts: {
        nodes: [
          {
            __typename: 'CheckRun',
            name: 'CI',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            detailsUrl: 'https://example.test/ci',
          },
          {
            __typename: 'StatusContext',
            context: 'lint',
            state: 'SUCCESS',
            targetUrl: 'https://example.test/lint',
          },
        ],
      },
    })
    assert.equal(rollup.length, 2)
    const checkRun = rollup[0]
    const statusContext = rollup[1]
    assert.ok(checkRun)
    assert.ok(statusContext)
    assert.equal(checkRun.name, 'CI')
    assert.equal(checkRun.conclusion, 'SUCCESS')
    assert.equal(statusContext.name, 'lint')
    assert.equal(statusContext.state, 'SUCCESS')
    assert.equal(statusContext.detailsUrl, 'https://example.test/lint')
  })
})

describe('checksFromGraphqlRollup', () => {
  it('uses rollup.state when contexts are still empty', () => {
    assert.equal(checksFromGraphqlRollup({ state: 'PENDING', contexts: { nodes: [] } }), 'pending')
    assert.equal(checksFromGraphqlRollup(null), 'no_checks')
  })
})

describe('graphqlPullToSummary', () => {
  it('copies CI rollup onto the summary so the pane can skip per-row fetches', () => {
    const summary = graphqlPullToSummary(
      {
        number: 7,
        title: 'Do a thing',
        url: 'https://github.com/octo/demo/pull/7',
        state: 'OPEN',
        headRefName: 'feat',
        author: { login: 'octo' },
        statusCheckRollup: {
          state: 'FAILURE',
          contexts: {
            nodes: [
              { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' },
            ],
          },
        },
      },
      { owner: 'octo', repo: 'demo' },
    )
    assert.ok(summary)
    assert.equal(summary.owner, 'octo')
    assert.equal(summary.checks, 'failure')
    assert.equal(summary.headRefName, 'feat')
  })
})
