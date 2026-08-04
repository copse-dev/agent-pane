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

  it('keeps the e2e hosted-runner fallback explicit and inside the trusted-event guard', () => {
    const e2eJob = workflow.match(/^ {2}e2e:\n(?: {4}.*\n)+/m)?.[0]
    assert.ok(e2eJob, 'expected an `e2e:` job in ci.yml')
    assert.match(e2eJob, /vars\.E2E_RUNNER == 'ubuntu-latest'/)
    assert.match(e2eJob, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
    assert.match(e2eJob, /fromJSON\('\["self-hosted", "copse-e2e"\]'\)/)
  })

  it('retains runner diagnostics when an e2e attempt loses its browser session', () => {
    assert.match(workflow, /capture_e2e_runner_diagnostics\(\)/)
    for (const cgroupFile of [
      '/sys/fs/cgroup/memory.current',
      '/sys/fs/cgroup/memory.peak',
      '/sys/fs/cgroup/memory.events',
      '/sys/fs/cgroup/pids.current',
    ]) {
      assert.match(workflow, new RegExp(cgroupFile.replaceAll('.', '\\.')))
    }
    assert.match(
      workflow,
      /capture_e2e_runner_diagnostics "\$attempt" "\$attempt_status" \|\| true/,
      'each failed outer retry must capture diagnostics without masking the test failure',
    )
    assert.match(
      workflow,
      /if: failure\(\)[\s\S]{0,400}?path: e2e-failure-artifacts\//,
      'failed shards must upload the runner diagnostics alongside browser artifacts',
    )
  })

  it('keeps the heavy tier off `develop` so day-to-day PRs stay cheap', () => {
    // The develop model only pays for itself if e2e/bench run once per PROMOTION
    // rather than once per PR. Both guards are easy to lose when someone edits an
    // unrelated clause in the same `if:`, and losing them is silent — CI simply
    // gets expensive again. Pin both halves: no heavy tier on a `develop` push,
    // and on a PR only when it targets `main` (or is force-labelled).
    for (const name of ['bench', 'e2e']) {
      const job = workflow.match(new RegExp(`^ {2}${name}:\\n(?: {4}.*\\n)+`, 'm'))?.[0]
      assert.ok(job, `expected a \`${name}:\` job in ci.yml`)
      assert.match(
        job,
        /github\.event_name != 'push' \|\| github\.ref != 'refs\/heads\/develop'/,
        `${name} must not run on pushes to develop`,
      )
      assert.match(
        job,
        /github\.base_ref == 'main'/,
        `${name} must only run on PRs that target main (promotion PRs)`,
      )
    }
  })

  it('forces promotion PRs through full e2e before consulting the oracle', () => {
    const planStep = workflow.match(/ {6}- id: plan\n[\s\S]*?(?=\n {6}- name: Plan reference)/)?.[0]
    assert.ok(planStep, 'expected the e2e planning step in ci.yml')
    assert.match(planStep, /BASE_REF: \$\{\{ github\.base_ref \}\}/)

    const promotionGate = planStep.indexOf(
      'if [ "$EVENT" = "pull_request" ] && [ "$BASE_REF" = "main" ]; then',
    )
    const oracle = planStep.indexOf('node scripts/test-oracle.mts --plan')
    assert.ok(promotionGate >= 0, 'promotion PRs must explicitly select mode=full')
    assert.ok(oracle >= 0, 'expected the e2e oracle invocation')
    assert.ok(promotionGate < oracle, 'promotion PRs must bypass oracle thinning')
  })

  it('does not let a cheap develop push satisfy the promotion aggregate gate', () => {
    const aggregate = workflow.match(/^ {2}ci-passed:\n[\s\S]*$/m)?.[0]
    assert.ok(aggregate, 'expected the `ci-passed` job in ci.yml')
    assert.match(
      aggregate,
      /name: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/develop' && 'Develop CI Passed' \|\| 'CI Passed' \}\}/,
      'develop pushes need a distinct aggregate check context',
    )
    assert.match(
      aggregate,
      /PROMOTION_PR=\$\{\{ github\.event_name == 'pull_request' && github\.base_ref == 'main'/,
      'the aggregate must identify same-repository promotion PRs',
    )
    assert.match(
      aggregate,
      /\$PROMOTION_PR && \[ "\$\{\{ needs\.precheck\.outputs\.e2e_shard_total \}\}" != "0" \] && \[ "\$\{\{ needs\.e2e\.result \}\}" != "success" \]/,
      'promotion PRs must fail closed unless e2e succeeds',
    )
  })

  it('only demands promotion e2e in the cases the e2e job actually dispatches', () => {
    // The gate demanding a job that skipped itself is a deadlock, not a
    // fail-closed: `CI Passed` can never go green, and because `pull_request`
    // has no `edited` trigger, retargeting away from `main` does not re-run CI,
    // so the false red outlives the move. Both escape hatches the `e2e` job
    // applies must therefore be mirrored on the demand side.
    const aggregate = workflow.match(/^ {2}ci-passed:\n[\s\S]*$/m)?.[0]
    assert.ok(aggregate, 'expected the `ci-passed` job in ci.yml')
    assert.match(
      aggregate,
      /PROMOTION_PR=[^\n]*github\.event\.pull_request\.draft == false \|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci-full'\)/,
      'a main-based draft skips e2e, so the gate must not demand it',
    )
    assert.match(
      aggregate,
      /\[ "\$\{\{ needs\.precheck\.outputs\.e2e_shard_total \}\}" != "0" \]/,
      'a zero-shard plan skips e2e, so the gate must not demand it',
    )
  })

  it('has no merge_group trigger (queue needs Enterprise Cloud; org is on Team)', () => {
    // Re-adding the trigger would look harmless but can never fire, and its
    // presence previously justified `github.event_name != 'merge_group'` guards
    // that are now dead weight in every heavy-tier `if:`.
    assert.doesNotMatch(workflow, /^ {2}merge_group:/m)
  })

  it('runs CI on pushes to both integration branches', () => {
    assert.match(
      workflow,
      /^ {4}branches: \[main, develop\]$/m,
      'push must cover develop (where merges land) and main (where promotions land)',
    )
  })
})

describe('promote-develop.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/promote-develop.yml'), 'utf8')

  it('runs daily and only opens a PR when develop has commits to promote', () => {
    assert.match(workflow, /- cron: '[^']+ \* \* \*'/)
    assert.match(workflow, /const base = 'main'/)
    assert.match(workflow, /const head = 'develop'/)

    const noChangesExit = workflow.indexOf('comparison.data.ahead_by === 0')
    const pullRequestLookup = workflow.indexOf('github.paginate')
    assert.match(workflow, /compare\/\{basehead\}/)
    assert.ok(noChangesExit >= 0, 'expected an explicit no-unpromoted-commits exit')
    assert.ok(
      noChangesExit < pullRequestLookup,
      'the no-changes exit must run before looking up or creating a promotion PR',
    )
    assert.doesNotMatch(
      workflow,
      /commit\.tree\.sha/,
      'tree equality must not hide commits discarded by a squash merge',
    )
  })

  it('enables merge-commit auto-merge through the existing required CI gate', () => {
    assert.match(workflow, /enablePullRequestAutoMerge/)
    assert.match(workflow, /mergeMethod: MERGE/)
    assert.doesNotMatch(workflow, /mergeMethod: SQUASH/)
    assert.match(workflow, /github-token: \$\{\{ secrets\.SYNC_PR_TOKEN \}\}/)
  })
})

describe('reconcile-screenshots.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/reconcile-screenshots.yml'), 'utf8')

  it('attempts the push before handing a workflow-file merge to a human', () => {
    // The hand-off must be driven by a REFUSED push, never by merely noticing a
    // .github/workflows change in the merge. Bailing pre-emptively made the
    // hand-off unconditional: it fired even when the token had `workflow` scope,
    // and because one base commit under .github/workflows/ lands in every stale
    // branch's merge, a single such commit handed off every open PR at once
    // (11 in one run, none with a real conflict).
    const step = workflow.match(/git add tests\/e2e\/screenshots\/[\s\S]*?(?=\n {6}- name:)/)?.[0]
    assert.ok(step, 'expected the reconcile merge step in reconcile-screenshots.yml')
    assert.match(step, /if git push; then/, 'the push must be attempted, not assumed to fail')
    assert.doesNotMatch(
      step,
      /wf="\$\([^)]*\)"\s*\n\s*if \[ -n "\$wf" \]; then\s*\n[\s\S]{0,200}?git merge --abort/,
      'must not abort the merge on workflow-file detection alone',
    )
  })

  it('leaves the branch untouched when the push is refused', () => {
    // A refused push must not leave a local merge commit behind or half-apply the
    // reconcile; the branch has to end up exactly as it was found.
    assert.match(workflow, /git reset --hard HEAD~1/)
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
