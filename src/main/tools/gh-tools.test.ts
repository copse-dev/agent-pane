import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ghPrListTool } from './gh-tools.ts'

describe('gh_pr_list parameters', () => {
  it('supports a detailed 200 PR query for a named repository', () => {
    assert.deepEqual(
      ghPrListTool.parameters.parse({
        state: 'open',
        limit: 200,
        repo: 'copse-dev/agent-pane',
        details: true,
      }),
      {
        state: 'open',
        limit: 200,
        repo: 'copse-dev/agent-pane',
        details: true,
      },
    )
    assert.equal(ghPrListTool.parameters.safeParse({ limit: 201 }).success, false)
  })
})
