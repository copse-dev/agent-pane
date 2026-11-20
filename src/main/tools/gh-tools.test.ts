import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ghPrListTool, ghRunListTool } from './gh-tools.ts'

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

describe('gh_run_list parameters', () => {
  it('keeps exact-commit, workflow and event selectors', () => {
    const selectors = { commit: 'a'.repeat(40), workflow: 'ci.yml', event: 'push' }
    assert.deepEqual(ghRunListTool.parameters.parse(selectors), {
      ...selectors,
      limit: 20,
      failed_only: false,
    })
    assert.equal(ghRunListTool.parameters.safeParse({ commit: 'main' }).success, false)
    assert.equal(ghRunListTool.parameters.safeParse({ workflow: ' ' }).success, false)
    assert.equal(ghRunListTool.parameters.safeParse({ event: '' }).success, false)
  })
})
