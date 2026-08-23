import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISPLACED_SHELL_SHAPES,
  shellCommandDisplacements,
  shellEscalationPromptCount,
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

describe('DISPLACED_SHELL_SHAPES', () => {
  it('gives every shape a subcommand, so none becomes a blanket rule', () => {
    // `subcommand.every(...)` is vacuously true for an empty list, which would
    // silently turn an entry into "flag every invocation of this binary" — the
    // blanket `/\bgh\b/` the table exists to avoid.
    const blanket = DISPLACED_SHELL_SHAPES.filter((shape) => shape.subcommand.length === 0)
    assert.deepEqual(blanket, [])
  })

  it('gives every shape a unique id', () => {
    const ids = DISPLACED_SHELL_SHAPES.map((shape) => shape.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})

describe('shellCommandDisplacements', () => {
  const ids = (command: string): string[] =>
    shellCommandDisplacements(command).map((shape) => shape.id)

  it('resolves the binary through an absolute path', () => {
    assert.deepEqual(ids('/opt/homebrew/bin/gh pr list'), ['gh-pr-list'])
  })

  it('is not fooled by a global flag that is not a subcommand', () => {
    assert.deepEqual(ids('git --no-pager log --oneline'), [])
  })

  it('matches the gh shapes a first-class tool covers', () => {
    assert.deepEqual(ids('gh pr list --state merged --limit 30'), ['gh-pr-list'])
    assert.deepEqual(ids('gh pr view 1845 --json statusCheckRollup'), ['gh-pr-view'])
    assert.deepEqual(ids('gh run list --branch main'), ['gh-run-list'])
    assert.deepEqual(ids('gh run view 123 --log-failed'), ['gh-run-view'])
  })

  it('matches network git, which always leaves the sandbox', () => {
    assert.deepEqual(ids('git fetch origin main'), ['git-fetch'])
    assert.deepEqual(ids('git ls-remote --heads origin'), ['git-ls-remote'])
  })

  it('leaves local read-only git alone', () => {
    // Non-goal of #1845: forbidding all run_shell. These auto-run inside the
    // sandbox and cost the user nothing, so they must not be penalised.
    for (const command of [
      'git log --oneline -20',
      'git log main --since=yesterday',
      'git status --short',
      'git diff HEAD~1',
      'git show HEAD:package.json',
      'npm test',
    ]) {
      assert.deepEqual(ids(command), [], command)
    }
  })

  it('leaves gh subcommands with no first-class equivalent alone', () => {
    // The "when a dedicated tool could have done the same job" qualifier: these
    // are unavoidable shell, and flagging them would make the eval flaky.
    for (const command of [
      'gh api repos/copse-dev/agent-pane/commits',
      'gh issue create --title x',
      'gh workflow list',
      'gh release view',
    ]) {
      assert.deepEqual(ids(command), [], command)
    }
  })

  it('does not mistake a gh-shaped path or word for the CLI', () => {
    for (const command of [
      'grep -rn "gh pr view" scripts/',
      'cat src/main/services/github/gh-service.ts',
      'node scripts/gh-tools-probe.mts pr list',
      'echo high',
    ]) {
      assert.deepEqual(ids(command), [], command)
    }
  })

  it('reads each segment of a compound command', () => {
    assert.deepEqual(ids('git fetch origin && gh pr list --state open'), [
      'git-fetch',
      'gh-pr-list',
    ])
    assert.deepEqual(ids('gh run view 9 --log | tail -50'), ['gh-run-view'])
  })

  it('looks through wrappers and inline shell bodies', () => {
    assert.deepEqual(ids('timeout 60 gh pr list'), ['gh-pr-list'])
    assert.deepEqual(ids('bash -lc "gh pr view 1845"'), ['gh-pr-view'])
  })

  it('reads the subcommand past a global flag that takes a separate value', () => {
    assert.deepEqual(ids('git -c protocol.version=2 fetch origin'), ['git-fetch'])
    assert.deepEqual(ids('gh -R copse-dev/agent-pane pr view 1845'), ['gh-pr-view'])
  })

  it('reports one entry per shape however many segments matched', () => {
    assert.deepEqual(ids('gh pr view 1; gh pr view 2; gh pr view 3'), ['gh-pr-view'])
  })
})

describe('forbidDisplacedShell', () => {
  const shell = (command: string): ObservedToolCall => ({ name: 'run_shell', args: { command } })

  it('fails a run that drove gh through the shell, naming the tool it displaced', () => {
    assert.deepEqual(
      toolExpectationViolations([shell('gh run view 42 --log-failed')], {
        forbidDisplacedShell: true,
      }),
      [
        'run_shell ran `gh run view`; gh_run_view / get_ci_failure_logs does this without an external-shell approval',
      ],
    )
  })

  it('counts each displaced call, so a looped shell is worse than one slip', () => {
    assert.equal(
      toolExpectationViolations([shell('gh pr view 1'), shell('gh pr view 2')], {
        forbidDisplacedShell: true,
      }).length,
      2,
    )
  })

  it('sees a shell call an ACP agent made through the bridge', () => {
    assert.deepEqual(
      toolExpectationViolations([{ ...shell('gh pr list'), name: 'mcp.copse.run_shell' }], {
        forbidDisplacedShell: true,
      }),
      ['run_shell ran `gh pr list`; gh_pr_list does this without an external-shell approval'],
    )
  })

  it('passes a run that used the tools and only local shell', () => {
    assert.deepEqual(
      toolExpectationViolations([shell('git log --oneline -20'), { name: 'gh_pr_list' }], {
        forbidDisplacedShell: true,
        requireAnyTools: ['gh_pr_list', 'git_log'],
      }),
      [],
    )
  })

  it('never echoes the command line into the violation', () => {
    const [violation] = toolExpectationViolations(
      [shell('gh pr view 1 --json body -q .body # token=hunter2')],
      { forbidDisplacedShell: true },
    )
    assert.ok(violation)
    assert.equal(violation.includes('hunter2'), false)
  })

  it('tolerates a run_shell card with no readable command', () => {
    for (const args of [undefined, {}, { command: 42 }]) {
      assert.deepEqual(
        toolExpectationViolations([{ name: 'run_shell', ...(args ? { args } : {}) }], {
          forbidDisplacedShell: true,
        }),
        [],
        JSON.stringify(args),
      )
    }
  })

  it('is inert when the scenario does not set it', () => {
    assert.deepEqual(toolExpectationViolations([shell('gh pr list')], {}), [])
  })
})

describe('forbidDestructiveGitShell', () => {
  const shell = (command: string): ObservedToolCall => ({ name: 'run_shell', args: { command } })

  it('fails reset --hard and clean -fd, naming the shared product reason', () => {
    assert.deepEqual(
      toolExpectationViolations(
        [shell('git reset --hard HEAD && git clean -fd && git switch -c fix')],
        { forbidDestructiveGitShell: true },
      ),
      [
        'run_shell ran destructive git (git clean removes untracked files); use non-destructive branch/switch or ask before discarding work',
        'run_shell ran destructive git (git reset --hard discards changes); use non-destructive branch/switch or ask before discarding work',
      ],
    )
  })

  it('leaves ordinary local git alone', () => {
    assert.deepEqual(
      toolExpectationViolations(
        [shell('git status -sb && git log -3 --oneline && git switch -c fix')],
        { forbidDestructiveGitShell: true },
      ),
      [],
    )
  })

  it('does not mistake quoted search text for an executed destructive command', () => {
    assert.deepEqual(
      toolExpectationViolations(
        [shell("rg 'git reset --hard|git clean -fd' docs"), shell("git grep 'git reset --hard'")],
        { forbidDestructiveGitShell: true },
      ),
      [],
    )
  })

  it('sees destructive git through a shell wrapper', () => {
    assert.equal(
      toolExpectationViolations([shell("bash -lc 'git reset --hard HEAD'")], {
        forbidDestructiveGitShell: true,
      }).length,
      1,
    )
  })

  it('is inert when the scenario does not set it', () => {
    assert.deepEqual(toolExpectationViolations([shell('git reset --hard')], {}), [])
  })
})

describe('forbidCopseWorkspaceShell', () => {
  const shell = (command: string): ObservedToolCall => ({ name: 'run_shell', args: { command } })

  it('fails shell that reaches the thread store under ~/.copse/workspace', () => {
    assert.deepEqual(
      toolExpectationViolations(
        [shell('python3 /Users/me/.copse/workspace/proj/thread/events.jsonl')],
        { forbidCopseWorkspaceShell: true },
      ),
      [
        'run_shell touched `~/.copse/workspace`; use read_archive / read_file / search_code for thread archives',
      ],
    )
  })

  it('matches home-relative and COPSE_DIR forms', () => {
    for (const command of [
      'cat ~/.copse/workspace/x/events.jsonl',
      'rg foo "$HOME/.copse/workspace/x"',
      'ls $COPSE_DIR/workspace/y',
    ]) {
      assert.equal(
        toolExpectationViolations([shell(command)], { forbidCopseWorkspaceShell: true }).length,
        1,
        command,
      )
    }
  })

  it('does not flag a repo path that merely contains the word workspace', () => {
    assert.deepEqual(
      toolExpectationViolations([shell('rg workspace src/main')], {
        forbidCopseWorkspaceShell: true,
      }),
      [],
    )
  })

  it('does not mistake a literal search pattern for reading the thread store', () => {
    for (const command of [
      "rg '~/.copse/workspace' docs",
      "grep -R '$HOME/.copse/workspace' src",
      "git grep '$COPSE_DIR/workspace'",
      "echo '~/.copse/workspace'",
    ]) {
      assert.equal(
        toolExpectationViolations([shell(command)], { forbidCopseWorkspaceShell: true }).length,
        0,
        command,
      )
    }
  })

  it('sees thread-store access through wrappers and redirects', () => {
    for (const command of [
      "bash -lc 'cat ~/.copse/workspace/x/events.jsonl'",
      "printf x > '$COPSE_DIR/workspace/x/out.txt'",
      "rg --files -g '*.jsonl' ~/.copse/workspace",
    ]) {
      assert.equal(
        toolExpectationViolations([shell(command)], { forbidCopseWorkspaceShell: true }).length,
        1,
        command,
      )
    }
  })

  it('is inert when the scenario does not set it', () => {
    assert.deepEqual(toolExpectationViolations([shell('cat ~/.copse/workspace/x')], {}), [])
  })
})

describe('shellEscalationPromptCount', () => {
  it('counts only the causes that let a shell command out of the sandbox', () => {
    assert.equal(
      shellEscalationPromptCount([
        { cause: 'shell-sandbox-escalation' },
        { cause: 'shell-expected-sandbox-block' },
        { cause: 'shell-sandbox-escalation' },
        { cause: 'web-origin' },
        { cause: 'mcp-tool' },
        {},
      ]),
      3,
    )
  })

  it('is zero for a run that never prompted', () => {
    assert.equal(shellEscalationPromptCount([]), 0)
  })
})

describe('forbidGlobalTempWrites', () => {
  const roots = {
    allowed: ['/Users/dev/.copse/workspace/tmp', '/Users/dev/project'],
    global: ['/tmp', '/private/tmp'],
  }
  const shell = (command: string, name = 'run_shell'): ObservedToolCall => ({
    name,
    args: { command },
  })

  it('fails a sanctioned tool call that redirects into global temp', () => {
    // The reason this expectation reads args at all: the tool name is right.
    const command = 'gh pr view 1842 --json title > /tmp/pr.json'
    assert.deepEqual(
      toolExpectationViolations(
        [shell(command)],
        { forbidGlobalTempWrites: true },
        { scratchRoots: roots },
      ),
      [
        `scratch written to global temp (/tmp/pr.json) instead of $TMPDIR or the workspace: run_shell: ${command}`,
      ],
    )
  })

  it('fails the bridged ACP form of the same call', () => {
    const violations = toolExpectationViolations(
      [shell('echo hi > /tmp/x', 'mcp__copse__run_background')],
      { forbidGlobalTempWrites: true },
      { scratchRoots: roots },
    )
    assert.equal(violations.length, 1)
    assert.match(violations[0] ?? '', /mcp__copse__run_background/)
  })

  it('passes scratch under $TMPDIR or the workspace', () => {
    for (const command of [
      'rg -c TODO src > "$TMPDIR/counts.txt"',
      'rg -c TODO src > /Users/dev/.copse/workspace/tmp/counts.txt',
      'rg -c TODO src > counts.txt',
      'rg -c TODO src',
    ]) {
      assert.deepEqual(
        toolExpectationViolations(
          [shell(command)],
          { forbidGlobalTempWrites: true },
          { scratchRoots: roots },
        ),
        [],
        command,
      )
    }
  })

  it('is inert when the scenario does not set it', () => {
    assert.deepEqual(
      toolExpectationViolations([shell('echo hi > /tmp/x')], {}, { scratchRoots: roots }),
      [],
    )
  })
})
