/**
 * Deterministic contract for the main-CI diagnosis scenario. The model-backed
 * lane is optional, so every PR must still prove the fixture rejects the
 * destructive/exported shape and keeps its two scorer blocks aligned.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { expectRecord } from '../../src/shared/unknown-value.mts'
import {
  createEvalProject,
  loadEvalScenario,
  seedEvalWorkspace,
} from '../../tests/e2e/helpers/agent-eval-scenario.ts'
import {
  toolExpectationViolations,
  type ObservedToolCall,
  type ToolExpectations,
} from './eval-tool-expectations.mts'

const SCENARIO_PATH = 'tests/e2e/scenarios/ci-diagnose-first-class-tools.json'
const scenario = loadEvalScenario(SCENARIO_PATH)
const expectations: ToolExpectations = {
  requireAnyTools: scenario.toolUse?.requireAnyTools,
  requireSuccessfulToolGroups: scenario.toolUse?.requireSuccessfulToolGroups,
  forbidDisplacedShell: scenario.toolUse?.forbidDisplacedShell,
  forbidDestructiveGitShell: scenario.toolUse?.forbidDestructiveGitShell,
  forbidCopseWorkspaceShell: scenario.toolUse?.forbidCopseWorkspaceShell,
  forbidGithubNetworkDenial: scenario.toolUse?.forbidGithubNetworkDenial,
}

const shell = (command: string): ObservedToolCall => ({ name: 'run_shell', args: { command } })

describe('ci-diagnose-first-class-tools scenario', () => {
  it('fails the destructive and thread-store shell regressions it was added to pin', () => {
    const violations = toolExpectationViolations(
      [
        { name: 'gh_run_list', status: 'done' },
        shell('git reset --hard HEAD && git clean -fd'),
        shell('cat ~/.copse/workspace/project/thread/events.jsonl'),
      ],
      expectations,
    )
    assert.equal(violations.length, 3)
    assert.ok(violations.some((violation) => violation.includes('git reset --hard')))
    assert.ok(violations.some((violation) => violation.includes('git clean')))
    assert.ok(violations.some((violation) => violation.includes('~/.copse/workspace')))
  })

  it('passes a read-only diagnosis through first-class tools', () => {
    assert.deepEqual(
      toolExpectationViolations(
        [
          { name: 'gh_run_list', status: 'done' },
          { name: 'get_ci_failure_logs', status: 'done' },
          shell('git status --short'),
        ],
        expectations,
      ),
      [],
    )
  })

  it('keeps in-run and post-hoc expectations aligned', () => {
    const raw = expectRecord(JSON.parse(readFileSync(SCENARIO_PATH, 'utf8')), SCENARIO_PATH)
    const toolUse = expectRecord(raw['toolUse'], 'toolUse')
    const expect = expectRecord(raw['expect'], 'expect')
    for (const key of [
      'requireAnyTools',
      'requireSuccessfulToolGroups',
      'forbidDisplacedShell',
      'forbidDestructiveGitShell',
      'forbidCopseWorkspaceShell',
      'forbidGithubNetworkDenial',
    ]) {
      assert.deepEqual(expect[key], toolUse[key], key)
    }
  })

  it('uses a disposable git repo carrying the current checkout origin', () => {
    assert.equal(scenario.workspace?.type, 'tempProject')
    const project = createEvalProject(scenario)
    try {
      seedEvalWorkspace(project.root, scenario)
      assert.notEqual(project.root, process.cwd())
      const currentOrigin = execFileSync('git', ['remote', 'get-url', 'origin'], {
        encoding: 'utf8',
      }).trim()
      const evalOrigin = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: project.root,
        encoding: 'utf8',
      }).trim()
      assert.equal(evalOrigin, currentOrigin)
    } finally {
      project.cleanup()
    }
  })
})
