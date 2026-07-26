import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Structural pins for workflow contracts that unit tests can enforce without
 * spinning Actions. Keep these narrow — they exist to catch accidental
 * regressions of known cost, fail-closed, and skip-mode gotchas.
 */
describe('ci.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')

  it('skips the e2e job when the oracle plans zero shards (empty matrix is a GHA failure)', () => {
    // GitHub Actions treats `strategy.matrix: []` as job failure, not skipped.
    // Zero-shard plans (mode=skip / empty subset) must therefore gate the job
    // via `e2e_shard_total` so `needs.e2e.result` is 'skipped' and the
    // mode=skip branch of `ci-passed` can accept the run (#1233).
    const e2eJob = workflow.match(/^ {2}e2e:\n(?: {4}.*\n)+/m)?.[0]
    assert.ok(e2eJob, 'expected an `e2e:` job in ci.yml')
    assert.match(
      e2eJob,
      /needs\.precheck\.outputs\.e2e_shard_total\s*!=\s*'0'/,
      'e2e job if: must require e2e_shard_total != 0 so empty matrices never evaluate',
    )
  })
})

describe('codeql.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/codeql.yml'), 'utf8')

  it('scans trusted main and schedule events without spending hosted PR minutes', () => {
    assert.doesNotMatch(workflow, /^ {2}pull_request:/m)
    assert.match(workflow, /^ {4}runs-on: \$\{\{ vars\.CHECKS_RUNNER \}\}$/m)
  })
})

describe('gitleaks workflow invariants', () => {
  const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
  const gitleaksWorkflow = readFileSync(resolve('.github/workflows/gitleaks.yml'), 'utf8')
  const sameRepositoryPr =
    "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository"

  it('scans same-repository PRs in precheck and leaves fork scans on hosted runners', () => {
    const precheckJob = ciWorkflow.match(/^ {2}precheck:\n[\s\S]*?(?=^ {2}[a-zA-Z0-9_-]+:\n)/m)?.[0]
    assert.ok(precheckJob, 'expected a `precheck:` job in ci.yml')
    assert.match(
      precheckJob,
      new RegExp(`- name: Install pinned gitleaks CLI\\n {8}if: ${sameRepositoryPr}`),
    )
    assert.match(
      precheckJob,
      new RegExp(`- name: Scan repository history for secrets\\n {8}if: ${sameRepositoryPr}`),
    )
    assert.match(
      gitleaksWorkflow,
      /^ {4}if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name != github\.repository$/m,
    )
    assert.match(gitleaksWorkflow, /^ {4}runs-on: ubuntu-latest$/m)
  })
})
