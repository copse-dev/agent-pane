import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCopseToolName } from '@shared/tools/copse-tool-call.ts'
import { matchesBridgedToolName, newBridgeServerName } from './acp-bridge-name.ts'

// #4125: the bridge is mounted under a name no static MCP config can predict.
describe('bridge server names', () => {
  it('gives each bridge its own copse-<nonce> name', () => {
    const names = new Set(Array.from({ length: 200 }, () => newBridgeServerName()))
    assert.equal(names.size, 200)
    for (const name of names) {
      assert.match(name, /^copse-[a-z0-9]{8}$/)
      assert.ok(!name.includes('__'), 'Claude splits mcp__<server>__<tool> at the next __')
    }
  })

  // Display and eval matching must recognise what the agent actually reports
  // under a fresh name, in every adapter's shape. `copse-tool-call.ts` copies
  // the name pattern because shared code cannot import this module; this is
  // the seam that keeps the copy in step.
  it('is recognised by the display normaliser and the eval matcher', () => {
    const server = newBridgeServerName()
    for (const reported of [
      `mcp__${server}__gh_pr_view`,
      `mcp.${server}.gh_pr_view`,
      `${server}-gh_pr_view: gh_pr_view`,
      // Threads recorded before #4125.
      'mcp__copse__gh_pr_view',
      'copse-gh_pr_view: gh_pr_view',
    ]) {
      assert.equal(normalizeCopseToolName(reported), 'gh_pr_view', reported)
      assert.ok(matchesBridgedToolName(reported, 'gh_pr_view'), reported)
    }
    assert.equal(matchesBridgedToolName(`mcp__${server}__gh_pr_view_extra`, 'gh_pr_view'), false)
    assert.equal(matchesBridgedToolName('mcp__other__gh_pr_view', 'gh_pr_view'), false)
  })
})
