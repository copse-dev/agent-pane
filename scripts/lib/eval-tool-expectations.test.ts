import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  toolExpectationViolations,
  usedTool,
  type ObservedToolCall,
} from './eval-tool-expectations.mts'

const called = (...names: string[]): ObservedToolCall[] => names.map((name) => ({ name }))

const auditOf = (...blocked: string[]): ObservedToolCall => ({
  name: 'sandbox_network_audit',
  args: { blocked },
})

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
      toolExpectationViolations(called('mcp.copse.gh_pr_view', 'mcp.copse.get_ci_status'), {
        requireTools: ['gh_pr_view'],
        forbidGithubNetworkDenial: true,
      }),
      [],
    )
  })

  it('reports a forbidden tool reached through the bridge', () => {
    assert.deepEqual(
      toolExpectationViolations(called('mcp.copse.run_shell'), { forbidTools: ['run_shell'] }),
      ['forbidden tool used: run_shell'],
    )
  })

  it('accepts any one of the alternatives', () => {
    assert.deepEqual(
      toolExpectationViolations(called('mcp.copse.get_ci_status'), {
        requireAnyTools: ['gh_pr_view', 'get_ci_status', 'gh_run_view'],
      }),
      [],
    )
  })

  it('fails a run that used none of the alternatives', () => {
    assert.deepEqual(
      toolExpectationViolations(called('read_file'), {
        requireAnyTools: ['gh_pr_view', 'get_ci_status'],
      }),
      ['expected at least one of these tools: gh_pr_view, get_ci_status'],
    )
  })

  it('treats an empty alternative list as no expectation', () => {
    assert.deepEqual(toolExpectationViolations([], { requireAnyTools: [] }), [])
  })
})

describe('forbidGithubNetworkDenial', () => {
  it('fails when the audit names a GitHub host, reporting which', () => {
    assert.deepEqual(
      toolExpectationViolations([auditOf('api.github.com:443')], {
        forbidGithubNetworkDenial: true,
      }),
      ["the agent's own process was denied GitHub: api.github.com:443"],
    )
  })

  it('ignores an audit that blocked only the adapter phoning home', () => {
    // The denials seen on nearly every real ACP turn: Claude's telemetry intake
    // and Cursor's package registry. Neither says anything about how the agent
    // reached GitHub, and failing on them made the scenario unusable.
    assert.deepEqual(
      toolExpectationViolations(
        [auditOf('http-intake.logs.us5.datadoghq.com:443', 'registry.npmjs.org:443')],
        { forbidGithubNetworkDenial: true },
      ),
      [],
    )
  })

  it('still fails when GitHub is blocked alongside unrelated hosts', () => {
    assert.deepEqual(
      toolExpectationViolations(
        [auditOf('http-intake.logs.us5.datadoghq.com:443', 'github.com:443')],
        { forbidGithubNetworkDenial: true },
      ),
      ["the agent's own process was denied GitHub: github.com:443"],
    )
  })

  it('reads the audit card through its bridged name too', () => {
    assert.deepEqual(
      toolExpectationViolations(
        [{ name: 'mcp.copse.sandbox_network_audit', args: { blocked: ['github.com:443'] } }],
        { forbidGithubNetworkDenial: true },
      ),
      ["the agent's own process was denied GitHub: github.com:443"],
    )
  })

  it('passes a run with no audit card at all', () => {
    assert.deepEqual(
      toolExpectationViolations(called('mcp.copse.gh_pr_view'), {
        forbidGithubNetworkDenial: true,
      }),
      [],
    )
  })

  it('is inert when the scenario does not set it', () => {
    assert.deepEqual(toolExpectationViolations([auditOf('github.com:443')], {}), [])
  })

  it('tolerates an audit card whose blocked list is missing or malformed', () => {
    for (const args of [undefined, {}, { blocked: 'github.com' }, { blocked: [1, null] }]) {
      assert.deepEqual(
        toolExpectationViolations([{ name: 'sandbox_network_audit', ...(args ? { args } : {}) }], {
          forbidGithubNetworkDenial: true,
        }),
        [],
        JSON.stringify(args),
      )
    }
  })
})
