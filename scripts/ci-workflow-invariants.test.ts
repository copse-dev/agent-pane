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

  /**
   * A whole job block, header through to the next top-level job. The
   * `(?: {4}.*\n)+` shape used by the older pins above stops at the first line
   * indented deeper than 4 spaces, so it only ever sees a job's `if:` /
   * `runs-on:` preamble — never its `steps:`.
   */
  function jobBlock(name: string): string {
    const start = workflow.search(new RegExp(`^ {2}${name}:$`, 'm'))
    assert.ok(start >= 0, `expected a \`${name}:\` job in ci.yml`)
    const rest = workflow.slice(start + 1)
    const next = rest.search(/^ {2}[a-z][a-z0-9-]*:$/m)
    return next >= 0 ? rest.slice(0, next) : rest
  }

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

  it('keeps the heavy tier off trunk so day-to-day PRs stay cheap', () => {
    // The trunk model only pays for itself if e2e/bench run once per PROMOTION
    // rather than once per PR. Both guards are easy to lose when someone edits an
    // unrelated clause in the same `if:`, and losing them is silent — CI simply
    // gets expensive again. Pin both halves: no heavy tier on a trunk (`main`)
    // push, and on a PR only when it targets `release` (or is force-labelled).
    for (const name of ['bench', 'e2e']) {
      const job = workflow.match(new RegExp(`^ {2}${name}:\\n(?: {4}.*\\n)+`, 'm'))?.[0]
      assert.ok(job, `expected a \`${name}:\` job in ci.yml`)
      assert.match(
        job,
        /github\.event_name != 'push' \|\| github\.ref != 'refs\/heads\/main'/,
        `${name} must not run on pushes to trunk`,
      )
      assert.match(
        job,
        /github\.base_ref == 'release'/,
        `${name} must only run on PRs that target release (promotion PRs)`,
      )
    }
  })

  it('forces promotion PRs through full e2e before consulting the oracle', () => {
    const planStep = workflow.match(/ {6}- id: plan\n[\s\S]*?(?=\n {6}- name: Plan reference)/)?.[0]
    assert.ok(planStep, 'expected the e2e planning step in ci.yml')
    assert.match(planStep, /BASE_REF: \$\{\{ github\.base_ref \}\}/)

    const promotionGate = planStep.indexOf(
      'if [ "$EVENT" = "pull_request" ] && [ "$BASE_REF" = "release" ]; then',
    )
    const oracle = planStep.indexOf('node scripts/test-oracle.mts --plan')
    assert.ok(promotionGate >= 0, 'promotion PRs must explicitly select mode=full')
    assert.ok(oracle >= 0, 'expected the e2e oracle invocation')
    assert.ok(promotionGate < oracle, 'promotion PRs must bypass oracle thinning')
  })

  it('does not let a cheap trunk push satisfy the promotion aggregate gate', () => {
    const aggregate = workflow.match(/^ {2}ci-passed:\n[\s\S]*$/m)?.[0]
    assert.ok(aggregate, 'expected the `ci-passed` job in ci.yml')
    assert.match(
      aggregate,
      /name: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && 'Develop CI Passed' \|\| 'CI Passed' \}\}/,
      'trunk pushes need a distinct aggregate check context',
    )
    assert.match(
      aggregate,
      /PROMOTION_PR=\$\{\{ github\.event_name == 'pull_request' && github\.base_ref == 'release'/,
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

  it('only thins the unit tier on a PR that cannot merge yet', () => {
    // The whole safety argument for thinning is that a stacked layer gets a
    // second, un-thinned run once it is retargeted at trunk. Lose the base_ref
    // guard and a PR could merge into `main` having run a subset — silently, and
    // with the coverage ratchet skipped alongside it.
    const check = jobBlock('check')
    assert.match(
      check,
      /STACKED_PR: \$\{\{ github\.event_name == 'pull_request' && github\.base_ref != 'main' && github\.base_ref != 'release' \}\}/,
      'thinning must be restricted to PRs stacked on another PR branch',
    )
    assert.match(
      check,
      /\[ "\$STACKED_PR" = "true" \] && \[ "\$UNIT_MODE" = "subset" \]/,
      'the subset arm must require STACKED_PR, not just a subset plan',
    )
    assert.match(
      check,
      /npm run coverage:ci/,
      'the unthinned arm must still run the coverage ratchet',
    )
    // A base branch name is attacker-chosen on any PR. Reaching the script
    // through `${{ }}` would splice it into the shell.
    assert.doesNotMatch(
      check.slice(check.indexOf('- name: Unit tests')),
      /run: \|[\s\S]*\$\{\{ github\.base_ref \}\}/,
      'base_ref must reach the unit-test script through the environment',
    )
  })

  it('reads an unset unit_mode as the full suite', () => {
    // `unit_mode` crosses a job boundary, so a plan branch that forgets to emit
    // one yields the empty string. That must land on `coverage:ci`, never on a
    // thinned run — fail safe, not fail cheap.
    const check = jobBlock('check')
    const subsetArm = check.indexOf('[ "$UNIT_MODE" = "subset" ]')
    const fallthrough = check.lastIndexOf('npm run coverage:ci')
    assert.ok(subsetArm >= 0 && fallthrough > subsetArm, 'coverage:ci must be the fallthrough arm')
  })

  it('emits a unit_mode from every branch of the plan step', () => {
    // Each early exit predates the oracle looking at the diff, so each must
    // pin the unit tier to `full`. A branch that emits only `mode=` would leave
    // `unit_mode` empty — safe today because `check` falls through to the full
    // suite, but the pin keeps that from being load-bearing by accident.
    const planStep = workflow.match(/ {6}- id: plan\n[\s\S]*?(?=\n {6}- name: Plan reference)/)?.[0]
    assert.ok(planStep, 'expected the plan step in ci.yml')
    const emits = planStep.match(/echo "mode=(?:full|subset|skip)"/g) ?? []
    const unitEmits = planStep.match(/echo "unit_mode=full"/g) ?? []
    assert.equal(
      emits.length,
      unitEmits.length,
      `every hardcoded mode= branch needs a unit_mode= sibling (${String(emits.length)} vs ${String(unitEmits.length)})`,
    )
    assert.match(
      planStep,
      /grep -E '\^\(mode\|specs\|unit_mode\|unit_specs\)=' plan\.txt/,
      'the oracle path must forward the unit plan to $GITHUB_OUTPUT',
    )
  })

  it('retires the update-screenshots label once the refresh has been committed', () => {
    // Nothing else removes it, and left on it stops being a request and becomes
    // a mode: the plan step forces mode=full and the label punches through the
    // `base_ref == release` guard on e2e, so a trunk PR re-runs 8 Electron
    // shards on every push forever (#1569).
    const job = jobBlock('commit-screenshots')
    assert.match(job, /name: Retire the update-screenshots label/)
    assert.match(
      job,
      /-X DELETE[\s\S]*?issues\/\$\{PR_NUMBER\}\/labels\/update-screenshots/,
      'the label must be deleted through the issues labels API',
    )
    assert.match(
      job,
      /pull-requests: write/,
      'removing a label needs pull-requests: write on this job',
    )
  })

  it('decides autofix has work to do before paying for the dependency install', () => {
    // The install is minutes; the autofix is seconds. Ordering them the other
    // way round means a diff with no formattable file pays the whole install to
    // print "nothing to do" — once per layer, per push.
    const job = jobBlock('autoformat')
    const listStep = job.indexOf('id: changed')
    const setup = job.indexOf('uses: ./.github/actions/setup')
    assert.ok(listStep >= 0, 'expected the changed-file listing step')
    assert.ok(setup > listStep, 'setup must come after the changed-file listing step')
    assert.match(
      job,
      /- uses: \.\/\.github\/actions\/setup\n {8}if: steps\.changed\.outputs\.any == 'true'/,
      'setup must be gated on there being something to fix',
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
      /^ {4}branches: \[release, main\]$/m,
      'push must cover main (where merges land) and release (where promotions land)',
    )
  })

  it('reconciles screenshots against the PR base branch, never a hardcoded one', () => {
    // This job merges the base branch into the PR head to clear binary conflicts
    // in reference PNGs. Hardcoding a branch name here fails SILENTLY: if the
    // named branch is already an ancestor of the PR base, `git merge` reports
    // "Already up to date" and the reconciliation never happens. That is exactly
    // what the pre-rename `origin/main` literal did on `develop`-based PRs, and
    // no run ever went red over it. Drive it from `github.base_ref` so both
    // tiers reconcile against the branch they will actually merge into.
    const job = workflow.match(/^ {2}commit-screenshots:\n(?: {4}.*\n| *\n)+/m)?.[0]
    assert.ok(job, 'expected a `commit-screenshots:` job in ci.yml')
    assert.match(
      job,
      /BASE_REF: \$\{\{ github\.base_ref \}\}/,
      'commit-screenshots must derive the reconciliation target from github.base_ref',
    )
    // Comments legitimately name `origin/main` when describing a script default;
    // only executable lines are the contract here.
    const executable = job
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    assert.doesNotMatch(
      executable,
      /origin\/main(?![.\w])/,
      'commit-screenshots must not hardcode origin/main — use "origin/$BASE_REF"',
    )
    assert.match(
      job,
      /git merge --no-commit --no-ff "origin\/\$BASE_REF"/,
      'the reconcile merge must target the base branch',
    )
    assert.match(
      job,
      /SCREENSHOT_MAIN_REF: origin\/\$\{\{ github\.base_ref \}\}/,
      'filter-screenshots.mts defaults to origin/main; it must be pointed at the PR base',
    )
  })

  it('caps every job, so one wedged run cannot park an ephemeral runner for six hours', () => {
    // GitHub's default `timeout-minutes` is 360. The runners here are ephemeral
    // and serve both tiers, so an uncapped job holds a whole runner — a real
    // slice of total capacity — while every other PR queues. This pin is the
    // part that lasts: a job added later without a cap fails here rather than
    // being discovered as a six-hour outage.
    // Scope to the `jobs:` section: `on:` also holds 2-space keys with no value
    // (`push:`, `pull_request:`, `schedule:`) that the job-name shape matches.
    const jobsSection = workflow.slice(workflow.search(/^jobs:$/m))
    const names = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
    assert.ok(names.length > 0, 'expected to find job names in ci.yml')
    const uncapped = names.filter((name) => !/^ {4}timeout-minutes: \d+$/m.test(jobBlock(name)))
    assert.deepEqual(
      uncapped,
      [],
      `every ci.yml job needs timeout-minutes; missing on: ${uncapped}`,
    )
  })
})

describe('promote-develop.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/promote-develop.yml'), 'utf8')

  it('runs daily and only opens a PR when trunk has commits to promote', () => {
    assert.match(workflow, /- cron: '[^']+ \* \* \*'/)
    assert.match(workflow, /const base = 'release'/)
    assert.match(workflow, /const head = 'main'/)

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

// Demos stopped carrying their own 34MB copy of Monaco and now share one
// published tree. That only works if both halves agree, and neither half fails
// on its own: the build succeeds, the publish succeeds, the deploy succeeds, and
// the tree is present on the branch. Only loading a published preview shows it,
// and only the editor is affected — so assert the pairing here instead.
describe('shared Monaco publishing invariants', () => {
  const demoPreview = readFileSync(resolve('.github/workflows/demo-preview.yml'), 'utf8')
  const pages = readFileSync(resolve('.github/workflows/pages.yml'), 'utf8')

  it('deploys the shared tree the demos are pointed at', () => {
    const assemble = pages.match(/for dir in [^\n]*/)?.[0]
    assert.ok(assemble, 'expected the assemble loop that mounts demo-previews targets')
    assert.match(
      assemble,
      /_previews\/vendor\//,
      'vendor/ is committed to demo-previews but only what this loop mounts is served',
    )
  })

  it('addresses it relatively, never through a repository-name prefix', () => {
    assert.match(demoPreview, /echo "base=\.\.\/vendor\/monaco\/\$\{version\}\/"/)
    // The site publishes under the site/CNAME custom domain, whose root is `/`.
    // An <owner>.github.io/<repo>/ style prefix 404s there — the original bug.
    assert.doesNotMatch(
      demoPreview,
      /base=\/\$\{?REPO|base=\/agent-pane\//,
      'copse.dev has no /agent-pane prefix; adding one makes every Monaco worker 404',
    )
  })
})
