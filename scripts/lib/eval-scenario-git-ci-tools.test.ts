/**
 * Deterministic discrimination test for the `git-ci-first-class-tools` scenario
 * (issue #1845).
 *
 * The model-backed lane that runs this scenario is scheduled or label-gated, so
 * nothing on the per-PR path would otherwise notice if the scenario stopped
 * failing the behaviour it exists to catch. Replaying the exported thread's
 * shape through the same scorer the harness uses closes that: the scoring is
 * gated on every PR even though the run is not.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadEvalScenario } from '../../tests/e2e/helpers/agent-eval-scenario.ts'
import { expectRecord } from '../../src/shared/unknown-value.mts'
import {
  toolExpectationViolations,
  type ObservedToolCall,
  type ToolExpectations,
} from './eval-tool-expectations.mts'

const SCENARIO_PATH = 'tests/e2e/scenarios/git-ci-first-class-tools.json'
const scenario = loadEvalScenario(SCENARIO_PATH)

const expectations: ToolExpectations = {
  requireAnyTools: scenario.toolUse?.requireAnyTools,
  forbidDisplacedShell: scenario.toolUse?.forbidDisplacedShell,
  forbidGithubNetworkDenial: scenario.toolUse?.forbidGithubNetworkDenial,
}

const shell = (command: string): ObservedToolCall => ({ name: 'run_shell', args: { command } })

/**
 * The tool loop recorded in thread `df76de32-d0e2-453e-af78-d0f6d5a4899a`:
 * `gh_run_list` answered part of the question with no decision at all, and
 * everything else went through the shell.
 */
const EXPORTED_FAILURE: ObservedToolCall[] = [
  { name: 'gh_run_list' },
  shell('git log --oneline -30 origin/main'),
  shell('git fetch origin main'),
  shell('gh run view 18234567 --log-failed'),
  shell('gh pr view 1839 --json title,state'),
  shell('gh pr view 1842 --json title,state'),
]

/** The same question answered through the tools, with only local shell. */
const GOOD_RUN: ObservedToolCall[] = [
  { name: 'git_log' },
  { name: 'gh_pr_list' },
  { name: 'get_ci_status' },
  shell('git log --oneline -20'),
  shell('npm run typecheck'),
]

describe('git-ci-first-class-tools scenario', () => {
  it('fails the exported thread from #1845', () => {
    const violations = toolExpectationViolations(EXPORTED_FAILURE, expectations)
    // Four of the five shell calls, each named: a looped shell is the pattern
    // that made the run expensive, so the count has to grow with it rather than
    // stopping at the first offender.
    assert.deepEqual(
      violations.map((violation) => violation.split(';')[0]),
      [
        'run_shell ran `git fetch`',
        'run_shell ran `gh run view`',
        'run_shell ran `gh pr view`',
        'run_shell ran `gh pr view`',
      ],
    )
    // The fifth is `git log`, a local read-only probe. Sparing it is the
    // non-goal of #1845 that keeps this from being "forbid all run_shell".
    assert.equal(
      violations.some((violation) => violation.includes('git log')),
      false,
    )
  })

  it('would have passed the old scoring, which is why the scenario is needed', () => {
    // `gh_run_list` alone satisfies requireAnyTools, and no forbidden tool name
    // appears. Without the displaced-shell signal this run scores green.
    assert.deepEqual(
      toolExpectationViolations(EXPORTED_FAILURE, {
        requireAnyTools: expectations.requireAnyTools,
        forbidGithubNetworkDenial: true,
      }),
      [],
    )
  })

  it('passes a run that used the tools and only local shell', () => {
    assert.deepEqual(toolExpectationViolations(GOOD_RUN, expectations), [])
  })

  it('fails a run that never attempted the task', () => {
    // The forbidden route is absent from a run that did nothing, so the
    // requireAnyTools conjunct is what keeps the pass meaningful.
    assert.deepEqual(toolExpectationViolations([{ name: 'read_file' }], expectations), [
      `expected at least one of these tools: ${(expectations.requireAnyTools ?? []).join(', ')}`,
    ])
  })

  it('requires at least one of the tools issue #1845 named', () => {
    assert.deepEqual(scenario.toolUse?.requireAnyTools, [
      'git_log',
      'gh_pr_list',
      'gh_pr_view',
      'gh_run_list',
      'gh_run_view',
      'get_ci_status',
    ])
  })

  it('keeps the in-run and post-hoc expectations in sync', () => {
    // `toolUse` is scored by the drive spec and `expect` by the thread
    // analyzer. They are separate blocks in one file, so nothing but this stops
    // an edit to one from silently leaving the other scoring the old contract.
    const raw = expectRecord(JSON.parse(readFileSync(SCENARIO_PATH, 'utf8')), SCENARIO_PATH)
    const toolUse = expectRecord(raw['toolUse'], 'toolUse')
    const expect = expectRecord(raw['expect'], 'expect')
    for (const key of ['requireAnyTools', 'forbidDisplacedShell', 'forbidGithubNetworkDenial']) {
      assert.deepEqual(expect[key], toolUse[key], key)
    }
  })

  it('varies the wording while fixing the intent', () => {
    const variants = scenario.promptVariants ?? []
    assert.ok(variants.length >= 3, 'the prompt class needs more than one wording')
    assert.equal(new Set(variants).size, variants.length, 'variants must differ')
    for (const variant of variants) {
      assert.match(variant, /main/i, variant)
      assert.match(variant, /\b(ci|checks?|landed|merged|commits)\b/i, variant)
    }
  })
})
