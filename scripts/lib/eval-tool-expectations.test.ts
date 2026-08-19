import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toolExpectationViolations, usedTool } from './eval-tool-expectations.mts'

describe('usedTool', () => {
  it('matches a bridged ACP call against the bare tool name a scenario writes', () => {
    // The three namespacing shapes observed on the wire: Codex dot-joined,
    // Claude infixed under `mcp__`, Cursor server-name leading.
    for (const observed of [
      'mcp.copse.gh_pr_view',
      'mcp__copse__gh_pr_view',
      'copse-gh_pr_view: gh_pr_view',
    ]) {
      assert.ok(usedTool([observed], 'gh_pr_view'), observed)
    }
  })

  it('matches a native tool call by exact name', () => {
    assert.ok(usedTool(['run_shell'], 'run_shell'))
  })

  it('does not match a different bridged tool sharing a prefix', () => {
    assert.equal(usedTool(['mcp.copse.gh_pr_list'], 'gh_pr'), false)
    assert.equal(usedTool(['mcp.copse.run_background'], 'run_shell'), false)
  })

  it('does not mistake prose or a command naming a tool for a call to it', () => {
    // Codex titles its own shell calls with the command, so observed names are
    // arbitrary text and must not be searched for the tool name anywhere.
    assert.equal(usedTool(['gh pr view --json statusCheckRollup'], 'gh_pr_view'), false)
    assert.equal(usedTool(['Edit copse-gh_pr_view-notes.md'], 'gh_pr_view'), false)
  })
})

describe('toolExpectationViolations', () => {
  it('passes a run that used a bridged form of every required tool', () => {
    assert.deepEqual(
      toolExpectationViolations(['mcp.copse.gh_pr_view', 'mcp.copse.get_ci_status'], {
        requireTools: ['gh_pr_view'],
        forbidTools: ['sandbox_network_audit'],
      }),
      [],
    )
  })

  it('reports a forbidden tool reached through the bridge', () => {
    assert.deepEqual(
      toolExpectationViolations(['mcp.copse.run_shell'], { forbidTools: ['run_shell'] }),
      ['forbidden tool used: run_shell'],
    )
  })

  it('accepts any one of the alternatives', () => {
    assert.deepEqual(
      toolExpectationViolations(['mcp.copse.get_ci_status'], {
        requireAnyTools: ['gh_pr_view', 'get_ci_status', 'gh_run_view'],
      }),
      [],
    )
  })

  it('fails a run that used none of the alternatives', () => {
    assert.deepEqual(
      toolExpectationViolations(['read_file'], {
        requireAnyTools: ['gh_pr_view', 'get_ci_status'],
      }),
      ['expected at least one of these tools: gh_pr_view, get_ci_status'],
    )
  })

  it('treats an empty alternative list as no expectation', () => {
    assert.deepEqual(toolExpectationViolations([], { requireAnyTools: [] }), [])
  })
})
