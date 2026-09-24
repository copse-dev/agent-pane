import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Structural pins for workflow contracts that unit tests can enforce without
 * spinning Actions. Keep these narrow — they exist to catch accidental
 * regressions of known cost, fail-closed, and skip-mode gotchas.
 */
describe('ci.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')

  it('starts a fresh CI run when a pull request is retargeted', () => {
    const trigger = workflow.match(/^ {2}pull_request:\n(?: {4}.*\n)+/m)?.[0]
    assert.ok(trigger, 'expected a `pull_request:` trigger in ci.yml')
    assert.match(
      trigger,
      /types: \[[^\]]*\bedited\b[^\]]*\]/,
      'base-branch edits must re-evaluate the tier and diff against the current base',
    )
  })

  it('does not let a cosmetic pull request edit cancel an in-flight run', () => {
    // Subscribing to `edited` for retargets also subscribes to title and body
    // edits, which arrive in the PR's own concurrency group mid-run. Cancelling
    // there is not a wasted run but a red one: since #2722 `ci-passed` turns a
    // cancelled run into an explicit failure rather than a skip, so a
    // description edit left a red `CI Passed` on a SHA that had been green.
    //
    // Truth table the expression has to hold, under GitHub's documented casting
    // (Null -> 0, Object -> NaN, and NaN equals nothing):
    //
    //   schedule                      -> false, the nightly never cancels
    //   push / synchronize / opened   -> true,  `action` is null or not 'edited'
    //   edited WITH    changes.base   -> true,  a retarget invalidates the run
    //   edited WITHOUT changes.base   -> false, cosmetic, leave the run alone
    const concurrency = workflow.slice(
      workflow.indexOf('\nconcurrency:'),
      workflow.indexOf('\njobs:'),
    )
    assert.ok(concurrency, 'expected a top-level `concurrency:` block in ci.yml')
    const clause = concurrency.match(/cancel-in-progress: (>-\n(?: {4}.+\n)+|.+\n)/)?.[1]
    assert.ok(clause, 'expected `cancel-in-progress` on the concurrency block')
    const expression = clause.replace(/^>-\n/, '').replace(/\s+/g, ' ').trim()
    assert.match(
      expression,
      /github\.event_name != 'schedule'/,
      'a late nightly must still not cancel an in-flight tip push or PR',
    )
    assert.match(
      expression,
      /github\.event\.action != 'edited' \|\| github\.event\.changes\.base != null/,
      'a title or body edit must not cancel a run; only a base retarget may',
    )
  })

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

  it('defaults e2e to hosted and keeps the self-hosted fleet opt-in and trust-gated', () => {
    // The pre-inversion expression read "anything that is not the
    // exact string 'ubuntu-latest' means the fleet", so deleting the variable
    // routed every PR/push e2e job to a pool with no registered runner and the
    // jobs queued forever. Hosted must be what an unset/mistyped variable
    // resolves to; the fleet must require an explicit opt-in value.
    const e2eJob = workflow.match(/^ {2}e2e:\n(?: {4}.*\n)+/m)?.[0]
    assert.ok(e2eJob, 'expected an `e2e:` job in ci.yml')
    assert.match(
      e2eJob,
      /vars\.SELF_HOSTED_E2E == 'copse-e2e'\s*\n\s*&& fromJSON\('\["self-hosted", "copse-e2e"\]'\)\s*\n\s*\|\| fromJSON\('\["ubuntu-latest"\]'\)/,
      'the fleet must be the opted-in branch and hosted the fallthrough, not the reverse',
    )
    assert.match(e2eJob, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
    assert.match(e2eJob, /fromJSON\('\["self-hosted", "copse-e2e"\]'\)/)
    // Fails closed for forks: no branch of the expression yields a runner for
    // an untrusted event, not even a free hosted one.
    assert.doesNotMatch(
      e2eJob,
      /head\.repo\.full_name != github\.repository/,
      'e2e must have no fork branch at all — the `if` guard skips forks and the runner expression fails closed',
    )
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

  it('keeps expensive post-merge repetitions off trunk pushes', () => {
    // Main pushes repeat the exact commit already gated as a PR. Keep the
    // expensive post-merge repeat off trunk; promotion and nightly remain the
    // environment/release-branch repetitions.
    for (const name of ['bench', 'e2e']) {
      const job = workflow.match(new RegExp(`^ {2}${name}:\\n(?: {4}.*\\n)+`, 'm'))?.[0]
      assert.ok(job, `expected a \`${name}:\` job in ci.yml`)
      assert.match(
        job,
        /github\.event_name != 'push' \|\| github\.ref != 'refs\/heads\/main'/,
        `${name} must not run on pushes to trunk`,
      )
    }
  })

  it('runs full e2e on merge-eligible PRs the oracle cannot safely thin', () => {
    const e2e = jobBlock('e2e')
    assert.match(e2e, /needs\.precheck\.outputs\.mode == 'full'/)
    assert.match(e2e, /needs\.precheck\.outputs\.mode == 'subset'/)
    assert.match(
      e2e,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
      'fork PRs must remain off the self-hosted e2e fleet',
    )
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

  it('runs the cancellation gate on hosted capacity without checkout or network dependencies', () => {
    const aggregate = jobBlock('ci-passed')
    assert.match(aggregate, /^ {4}if: \$\{\{ always\(\) \}\}$/m)
    assert.match(aggregate, /^ {4}runs-on: ubuntu-latest$/m)
    assert.match(aggregate, /^ {4}timeout-minutes: 5$/m)
    assert.match(aggregate, /^ {4}permissions: \{\}$/m)
    assert.doesNotMatch(aggregate, /SELF_HOSTED_CHECKS|uses:|api_get|curl |gh api|GH_TOKEN/)
    assert.match(aggregate, /- name: Reject canceled workflow\n {8}if: \$\{\{ cancelled\(\) \}\}/)
  })

  it('does not let a cheap trunk push satisfy the promotion aggregate gate', () => {
    const aggregate = workflow.match(/^ {2}ci-passed:\n[\s\S]*$/m)?.[0]
    assert.ok(aggregate, 'expected the `ci-passed` job in ci.yml')
    // Assert the property, not the formatting. The expression outgrew one line
    // when fork runs gained their own context (#2520), and pinning the literal
    // meant a correct change to it read as a regression. What has to hold is
    // that each cheap tier publishes a check name a required `CI Passed` rule
    // cannot match: trunk pushes skip the expensive tier, and fork PRs skip
    // `check`, `build` and `e2e` entirely.
    const nameBlock = aggregate.match(/^ {4}name: (>-\n(?: {6}.+\n)+|.+\n)/m)?.[1]
    assert.ok(nameBlock, 'expected a `name:` on ci-passed')
    const nameExpr = nameBlock.replace(/^>-\n/, '').replace(/\s+/g, ' ').trim()
    assert.match(
      nameExpr,
      /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && 'Develop CI Passed'/,
      'trunk pushes need a distinct aggregate check context',
    )
    assert.match(
      nameExpr,
      /head\.repo\.full_name != github\.repository\) && 'Fork CI Passed'/,
      'fork PRs need a distinct aggregate check context: their run skips check/build/e2e',
    )
    assert.match(
      nameExpr,
      /\|\| 'CI Passed' \}\}$/,
      "everything else — same-repo PRs included — must still publish 'CI Passed'",
    )
    assert.match(
      aggregate,
      /E2E_REQUIRED: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
      'the aggregate must identify same-repository PRs whose e2e job dispatched',
    )
    assert.match(
      aggregate,
      /\[ "\$E2E_REQUIRED" = "true" \] && \[ "\$E2E_SHARD_TOTAL" != "0" \] && \[ "\$E2E_RESULT" != "success" \]/,
      'merge-eligible same-repository PRs must fail closed unless required e2e succeeds',
    )
  })

  it('only demands PR e2e in the cases the e2e job actually dispatches', () => {
    // The gate demanding a job that skipped itself is a deadlock, not a
    // fail-closed: `CI Passed` can never go green until another event starts a
    // corrected run. Both escape hatches the `e2e` job applies must therefore
    // be mirrored on the demand side.
    const aggregate = workflow.match(/^ {2}ci-passed:\n[\s\S]*$/m)?.[0]
    assert.ok(aggregate, 'expected the `ci-passed` job in ci.yml')
    assert.match(
      aggregate,
      /E2E_REQUIRED: [^\n]*github\.event\.pull_request\.draft == false \|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci-full'\)/,
      'a draft skips e2e, so the gate must not demand it',
    )
    assert.match(
      aggregate,
      /\[ "\$E2E_SHARD_TOTAL" != "0" \]/,
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

  it('publishes screenshot candidates without mutating the PR branch', () => {
    const job = jobBlock('screenshot-artifacts')
    assert.match(job, /permissions:\n {6}contents: read/)
    assert.match(job, /!cancelled\(\) && needs\.build\.result == 'success'/)
    assert.doesNotMatch(job.slice(0, job.indexOf('    steps:')), /always\(\)/)
    assert.match(job, /name: reference-screenshot-candidates-\$\{\{ github\.run_id \}\}/)
    assert.match(job, /retention-days: 14/)
    assert.doesNotMatch(job, /contents: write|pull-requests: write/)
    assert.doesNotMatch(job, /git (?:commit|merge|push)|actions\/create-github-app-token/)
    assert.equal(
      existsSync(resolve('.github/workflows/reconcile-screenshots.yml')),
      false,
      'base-branch pushes must not mutate every open PR to reconcile binary screenshots',
    )

    const aggregate = jobBlock('ci-passed')
    assert.match(
      aggregate,
      /needs: \[precheck, check, review-cell, bench, build, e2e, screenshot-artifacts\]/,
      'the aggregate must wait until immutable screenshot evidence is published',
    )
  })

  it('boots the real reviewer cell when its trust boundary changes', () => {
    const precheck = jobBlock('precheck')
    assert.match(
      precheck,
      /review_cell_required: \$\{\{ steps\.review-cell-plan\.outputs\.required \}\}/,
    )
    assert.match(precheck, /git diff --quiet "\$\{BASE_SHA\}"\.\.\.HEAD --/)
    assert.match(precheck, /packages\/review/)
    assert.match(precheck, /scripts\/prepare-review-stage0\.mts/)

    const cell = jobBlock('review-cell')
    assert.match(cell, /runs-on: ubuntu-latest/)
    assert.match(cell, /persist-credentials: false/)
    assert.match(cell, /docker build --pull/)
    assert.match(cell, /COPSE_REVIEW_CONTAINER_E2E: '1'/)
    assert.match(cell, /COPSE_REVIEW_DEPENDENCY_STORE: \$\{\{ runner\.temp \}\}\/pnpm-store/)
    assert.match(cell, /npm test -- packages\/review\/src\/hostile-fixture\.test\.ts/)

    const aggregate = jobBlock('ci-passed')
    assert.match(aggregate, /needs: \[[^\]]*review-cell[^\]]*\]/)
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

  it('lets every branch-checkout job no-op when the PR merged and deleted its head', () => {
    // These jobs are dispatched by `pull_request` but can execute minutes later,
    // queued behind the fleet. If the PR merges meanwhile, auto-delete takes the
    // head branch and `checkout` with `ref: github.head_ref` dies with "branch
    // not found" — a red X on an already-merged PR, and pure noise, since there
    // is no longer a branch to push to. `autoformat` reddened 11 of 26 PRs in one
    // night before getting this guard. Any future job that checks out the head
    // ref needs it too.
    for (const name of ['autoformat']) {
      const job = jobBlock(name)
      assert.match(job, /id: head\n/, `${name} must probe the head branch before checking it out`)
      assert.match(
        job,
        /- uses: actions\/checkout@[^\n]*\n {8}if: steps\.head\.outputs\.exists == 'true'/,
        `${name} must skip checkout once the head branch is gone`,
      )
      // A transport blip must not read as deletion — that would silently skip
      // real work rather than fail loudly.
      assert.match(job, /refusing to/, `${name} must fail closed on a non-404 lookup`)
    }
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

  it('caps every job, so one wedged run cannot park an ephemeral runner for six hours', () => {
    // GitHub's default `timeout-minutes` is 360. The runners here are ephemeral
    // and serve both tiers, so an uncapped job holds a whole runner — a real
    // slice of total capacity — while every other PR queues. This pin is the
    // part that lasts: a job added later without a cap fails here rather than
    // being discovered as a six-hour outage.
    // Scope to the `jobs:` section: `on:` also holds 2-space keys with no value
    // (`push:`, `pull_request:`, `schedule:`) that the job-name shape matches.
    const jobsSection = workflow.slice(workflow.search(/^jobs:$/m))
    // `noUncheckedIndexedAccess` types a capture group as `string | undefined`, so collect
    // through an explicit guard rather than `.map(m => m[1])` — same shape as
    // `staticImports` in agent-path-electron-surface.test.ts.
    const names: string[] = []
    for (const match of jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)) {
      const name = match[1]
      if (name !== undefined) names.push(name)
    }
    assert.ok(names.length > 0, 'expected to find job names in ci.yml')
    const uncapped = names.filter((name) => !/^ {4}timeout-minutes: \d+$/m.test(jobBlock(name)))
    assert.deepEqual(
      uncapped,
      [],
      `every ci.yml job needs timeout-minutes; missing on: ${uncapped.join(', ')}`,
    )
  })
})

describe('publish-screenshot-candidates.yml workflow invariants', () => {
  const workflow = readFileSync(
    resolve('.github/workflows/publish-screenshot-candidates.yml'),
    'utf8',
  )

  it('separates the write-capable publisher from pull-request code execution', () => {
    assert.match(workflow, /^ {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]$/m)
    assert.doesNotMatch(workflow, /pull_request_target/)
    assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/)
    assert.match(
      workflow,
      /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/,
      'fork runs receive secrets on workflow_run and must be rejected before token minting',
    )
    assert.match(
      workflow,
      /^permissions:\n {2}actions: read\n {2}contents: read\n {2}pull-requests: read$/m,
    )
    assert.match(workflow, /permission-contents: write/)
    assert.match(workflow, /permission-pull-requests: write/)
  })

  it('binds publication to one open parent at the exact rendered head', () => {
    assert.match(workflow, /candidates\.length !== 1/)
    assert.match(workflow, /parent\.state !== 'open'/)
    assert.match(workflow, /parent\.head\.repo\?\.full_name === `\$\{owner\}\/\$\{repo\}`/)
    assert.match(workflow, /parent\.head\.ref === 'main' \|\| parent\.head\.ref === 'release'/)
    assert.match(workflow, /parent\.head\.sha !== runHeadSha/)
    assert.match(workflow, /artifact\.name === artifactName && !artifact\.expired/)
    assert.match(workflow, /ref: \$\{\{ steps\.discover\.outputs\.head-sha \}\}/)
    assert.match(workflow, /persist-credentials: false/)
    assert.match(
      workflow,
      /parent\.head\.sha !== process\.env\.EXPECTED_HEAD_SHA[\s\S]*?state: 'closed'/,
      'a parent-head race after child creation must close the stale review PR',
    )
  })

  it('accepts only bounded, flat, real PNG candidates', () => {
    assert.match(workflow, /find "\$CANDIDATE_ROOT" -type l/)
    assert.match(workflow, /tests\/e2e\/screenshots\/\*\.png\)/)
    assert.match(workflow, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\\\.png\$/)
    assert.match(workflow, /89504e470d0a1a0a/)
    assert.match(workflow, /"\$size" -gt 16777216/)
    assert.match(workflow, /"\$count" -gt 512/)
    assert.match(workflow, /"\$total" -gt 268435456/)
    assert.match(workflow, /Unexpected file in screenshot candidate artifact/)
  })

  it('opens a bot-owned child PR into the source branch and links it from the parent', () => {
    assert.match(workflow, /uses: peter-evans\/create-pull-request@v8/)
    assert.match(workflow, /base: \$\{\{ steps\.discover\.outputs\.head-ref \}\}/)
    assert.match(workflow, /branch: \$\{\{ steps\.discover\.outputs\.review-branch \}\}/)
    assert.match(workflow, /add-paths: tests\/e2e\/screenshots\//)
    assert.doesNotMatch(workflow, /^ {10}base: main$/m)
    assert.match(workflow, /<!-- copse-e2e-screenshot-review -->/)
    assert.match(workflow, /REVIEW_URL: \$\{\{ steps\.review-pr\.outputs\.pull-request-url \}\}/)
    assert.match(workflow, /Review GitHub’s image diffs in \[screenshot PR #/)
    assert.match(workflow, /Close superseded screenshot review PRs/)
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
    assert.match(workflow, /github-token: \$\{\{ steps\.app-token\.outputs\.token \}\}/)
  })
})

describe('release-cut.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/release-cut.yml'), 'utf8')

  it('cuts from pushes to release only', () => {
    assert.match(workflow, /^ {4}branches: \[release\]$/m)
    assert.doesNotMatch(
      workflow,
      /branches: \[[^\]]*main/,
      'cutting from trunk would skip the promotion gate that release exists to enforce',
    )
  })

  it('is a no-op when the promoted version is already tagged', () => {
    // Most promotions carry an already-released version. Without the 404 guard
    // this workflow would fail on every ordinary promotion, and re-cutting an
    // existing tag would move a published release's commit.
    assert.match(workflow, /git\.getRef\(\{ owner, repo, ref: `tags\/\$\{tag\}` \}\)/)
    assert.match(workflow, /if \(error\.status !== 404\) throw error/)
    const guard = workflow.indexOf('error.status !== 404')
    const create = workflow.indexOf('git.createRef')
    assert.ok(guard >= 0 && create > guard, 'the existing-tag check must precede tag creation')
  })

  it('starts the signed build by dispatch, because a GITHUB_TOKEN tag raises no push event', () => {
    // `push: tags` on release-mac.yml cannot fire for a tag this token created,
    // so dropping the dispatch would silently cut tags nothing ever publishes.
    assert.match(workflow, /createWorkflowDispatch/)
    assert.match(workflow, /workflow_id: 'release-mac\.yml'/)
    assert.match(workflow, /^ {2}actions: write/m)
    assert.match(workflow, /^ {2}contents: write/m)
  })

  it('recovers when tag creation succeeded but dispatch did not', () => {
    // The tag is immutable release state. If createRef succeeds and dispatch
    // transiently fails, a rerun must not strand that version behind the
    // ordinary existing-tag no-op. Running the signed build at the tag gives its
    // workflow run the release SHA, which also makes duplicate detection exact.
    assert.match(workflow, /existing\.data\.object\.sha !== sha/)
    assert.match(workflow, /listWorkflowRuns\(\{/)
    assert.match(workflow, /head_sha: sha/)
    assert.match(workflow, /ref: tag/)
    const sameCommitGuard = workflow.indexOf('existing.data.object.sha !== sha')
    const existingRunLookup = workflow.indexOf('listWorkflowRuns')
    const dispatch = workflow.indexOf('createWorkflowDispatch')
    assert.ok(
      sameCommitGuard >= 0 && existingRunLookup > sameCommitGuard && dispatch > existingRunLookup,
      'an exact-tag rerun must check for an existing release run before dispatching',
    )
  })

  it('classifies the version and proves the notes exist before tagging', () => {
    // Both fail closed in seconds; the same failures after a dispatch would cost
    // a full sign-and-notarize cycle first.
    assert.match(workflow, /release-channel\.mts --channel/)
    assert.match(workflow, /release-notes\.mts/)
  })
})

describe('release-mac.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/release-mac.yml'), 'utf8')

  it('requires the tagged commit to be reachable from release, not trunk', () => {
    // A promotion merge is a commit ON `release` and is not reachable from
    // `main`, so an ancestry check against trunk rejects every real release.
    assert.match(workflow, /--is-ancestor "\$release_sha" origin\/release/)
    assert.doesNotMatch(workflow, /--is-ancestor "\$release_sha" origin\/main/)
  })

  it('uploads release notes with immutable metadata and does not publish', () => {
    assert.match(workflow, /release-notes\.mts > release\/RELEASE_NOTES\.md/)
    assert.match(
      workflow,
      /name: copse-macos-\$\{\{ needs\.preflight\.outputs\.release_sha \}\}-metadata[\s\S]*release\/RELEASE_NOTES\.md/,
      'the notes must travel in the immutable tested metadata artifact',
    )
    assert.doesNotMatch(workflow, /^ {2}publish:$/m)
    assert.doesNotMatch(workflow, /^\s+gh release create /m)
  })

  it('builds and uploads each architecture separately', () => {
    assert.match(workflow, /arch: \[arm64, x64\]/)
    assert.match(workflow, /"dmg:\$TARGET_ARCH" "zip:\$TARGET_ARCH"/)
    assert.match(workflow, /name: copse-macos-.*-\$\{\{ matrix\.arch \}\}/)
    assert.match(workflow, /check-macos-release-size\.mts release \$\{\{ matrix\.arch \}\}/)
    assert.doesNotMatch(workflow, /prepare:gortex:mac/)
  })

  it('assembles portable checksums without recompressing the packages', () => {
    assert.match(workflow, /assemble-macos-release\.mts/)
    assert.match(workflow, /shasum -a 256 --check SHA256SUMS/)
    assert.match(workflow, /release\/SHA256SUMS/)
  })

  it('skips provenance on a private repository instead of failing the release', () => {
    // Artifact attestations need a public repository or GitHub Enterprise Cloud;
    // on Team + private the action fails the job outright.
    assert.match(
      workflow,
      /if: \$\{\{ !github\.event\.repository\.private \}\}\n {8}uses: actions\/attest/,
    )
    assert.match(workflow, /if: github\.event\.repository\.private/)
  })

  it('packages on a runner that can run an LSMinimumSystemVersion 26.0 build', () => {
    assert.match(workflow, /^ {4}runs-on: macos-26$/m)
    assert.doesNotMatch(workflow, /runs-on: macos-14/)
  })

  it('bounds the signed package verification step', () => {
    assert.match(workflow, /^ {4}timeout-minutes: 60$/m)
    assert.match(
      workflow,
      /- name: Verify signatures, notarization, metadata, and packaged runtime\n {8}timeout-minutes: 15/,
    )
    assert.match(workflow, /COPSE_DIR: \$\{\{ runner\.temp \}\}\/copse-release-smoke-profile/)
  })
})

describe('release-publish.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/release-publish.yml'), 'utf8')

  it('is manual and publishes only to the public binary repository', () => {
    assert.match(workflow, /^ {2}workflow_dispatch:$/m)
    assert.doesNotMatch(workflow, /^ {2}push:/m)
    assert.match(workflow, /RELEASE_REPOSITORY: copse-dev\/copse-releases/)
    assert.match(workflow, /\/repos\/\$RELEASE_REPOSITORY.*--jq \.private/)
    assert.match(workflow, /Refusing to publish to private repository/)
    assert.doesNotMatch(workflow, /Refusing to publish from a private repository/)
  })

  it('uses the release App only for the cross-repository publication', () => {
    assert.match(workflow, /uses: actions\/create-github-app-token@v3/)
    assert.match(workflow, /repositories: copse-releases/)
    assert.match(workflow, /permission-contents: write/)
    assert.match(workflow, /SOURCE_GH_TOKEN: \$\{\{ github\.token \}\}/)
    assert.match(workflow, /RELEASE_GH_TOKEN: \$\{\{ steps\.release-token\.outputs\.token \}\}/)
  })

  it('accepts only a successful release-mac run for the exact tagged commit', () => {
    assert.match(workflow, /\.github\/workflows\/release-mac\.yml/)
    assert.match(workflow, /source_sha.*release_sha/)
    assert.match(workflow, /source_status.*completed/)
    assert.match(workflow, /source_conclusion.*success/)
    assert.match(workflow, /--is-ancestor "\$release_sha" origin\/release/)
  })

  it('downloads, verifies, and publishes without rebuilding', () => {
    assert.match(workflow, /run-id: \$\{\{ inputs\.release_run_id \}\}/)
    assert.match(workflow, /pattern: copse-macos-.*-\*/)
    assert.match(workflow, /merge-multiple: true/)
    assert.match(workflow, /cd release\n {12}shasum -a 256 --check SHA256SUMS/)
    assert.match(workflow, /uses: actions\/attest@/)
    assert.match(workflow, /--notes-file "\$notes"/)
    assert.match(workflow, /gh release create/)
    assert.match(workflow, /--repo "\$RELEASE_REPOSITORY" --target main/)
    assert.doesNotMatch(workflow, /electron-builder|build:release|pnpm install/)
  })

  it('skips unavailable provenance only while the source repository is private', () => {
    assert.match(
      workflow,
      /if: \$\{\{ !github\.event\.repository\.private \}\}\n {8}uses: actions\/attest/,
    )
    assert.match(workflow, /if: github\.event\.repository\.private/)
  })
})

describe('runner-routing invariants across every workflow', () => {
  const dir = resolve('.github/workflows')
  const workflows = readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => ({ name: f, body: readFileSync(resolve(dir, f), 'utf8') }))

  it('never reads the retired CHECKS_RUNNER / E2E_RUNNER variables', () => {
    // `vars.X` resolves repo-then-org, and an expression cannot tell the two
    // apart. While these names were read here, an org-level
    // CHECKS_RUNNER=copse-checks silently re-routed this repository's whole
    // check tier onto the self-hosted fleet with no change in this repo and no
    // signal on the PR — the exact thing a public repo must not allow. Reading
    // names that are set nowhere is what makes hosted the default in code.
    for (const { name, body } of workflows) {
      assert.doesNotMatch(
        body,
        /vars\.(CHECKS_RUNNER|E2E_RUNNER)\b/,
        `${name} reads a retired runner variable; use SELF_HOSTED_CHECKS / SELF_HOSTED_E2E (opt-in, hosted by default)`,
      )
    }
  })

  it('gives every self-hosted opt-in a hosted default', () => {
    // A bare `${{ vars.SELF_HOSTED_CHECKS }}` renders an empty `runs-on` when
    // the variable is unset, which errors the job. Every read must name the
    // hosted fallback inline so the default is visible at the call site.
    for (const { name, body } of workflows) {
      for (const line of body.split('\n')) {
        if (!line.includes('vars.SELF_HOSTED_CHECKS')) continue
        assert.match(
          line,
          /vars\.SELF_HOSTED_CHECKS \|\| 'ubuntu-latest'/,
          `${name}: \`${line.trim()}\` must fall back to 'ubuntu-latest'`,
        )
      }
    }
  })
})

describe('codeql.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/codeql.yml'), 'utf8')

  it('scans trusted main and schedule events on a runner that always resolves', () => {
    assert.doesNotMatch(workflow, /^ {2}pull_request:/m)
    // Previously `${{ vars.CHECKS_RUNNER }}` with no fallback: with the
    // variable unset this rendered an empty `runs-on` and the job errored
    // rather than running anywhere. Hosted minutes are free on a public repo,
    // so the check tier's default is the right resolution here too.
    assert.match(
      workflow,
      /^ {4}runs-on: \$\{\{ vars\.SELF_HOSTED_CHECKS \|\| 'ubuntu-latest' \}\}$/m,
    )
  })
})

describe('acp-v2-watch.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/acp-v2-watch.yml'), 'utf8')

  it('runs nightly and never gates a PR', () => {
    // The watch polls npm for a protocol-v2 ACP SDK (docs/acp-v2-readiness.md).
    // Its red run means "upstream moved", not "this change is broken", so it
    // must stay off pull_request — on a PR trigger every unrelated PR would go
    // red the day v2 ships.
    assert.match(workflow, /^ {4}- cron: '[^']+'$/m)
    assert.doesNotMatch(workflow, /^ {2}pull_request:/m)
  })

  it('skips the dependency restore the watch is written to avoid', () => {
    // Dependency-free is the whole reason this is a 30-second job. A setup-action
    // call here would quietly reintroduce the multi-minute node_modules restore.
    assert.doesNotMatch(workflow, /uses: \.\/\.github\/actions\/setup/)
    assert.match(workflow, /run: pnpm run watch:acp-v2/)
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

describe('Copse Reviewer workflow invariants', () => {
  const triggerWorkflow = readFileSync(resolve('.github/workflows/review-trigger.yml'), 'utf8')
  const groundWorkflow = readFileSync(resolve('.github/workflows/review-ground.yml'), 'utf8')
  const findingsWorkflow = readFileSync(resolve('.github/workflows/review-findings.yml'), 'utf8')
  const nightlyWorkflow = readFileSync(resolve('.github/workflows/review-nightly.yml'), 'utf8')
  const modelBenchWorkflow = readFileSync(
    resolve('.github/workflows/review-model-bench.yml'),
    'utf8',
  )
  const reviewCellDockerfile = readFileSync(resolve('packages/review/Dockerfile.cell'), 'utf8')
  const forgeReview = readFileSync(resolve('packages/review/src/forge-review.ts'), 'utf8')

  function workflowJobBlock(workflow: string, name: string): string {
    const header = `  ${name}:\n`
    const start = workflow.indexOf(header)
    assert.ok(start >= 0, `expected a \`${name}:\` job`)
    const rest = workflow.slice(start + header.length)
    const next = rest.search(/^ {2}[a-z][a-z0-9_-]*:\n/m)
    return next >= 0 ? workflow.slice(start, start + header.length + next) : workflow.slice(start)
  }

  it('executes pull-request code only in credential-free execution cells', () => {
    assert.match(triggerWorkflow, /^ {2}pull_request_target:\n {4}types: \[labeled\]$/m)
    assert.doesNotMatch(triggerWorkflow, /actions\/checkout/)
    assert.doesNotMatch(triggerWorkflow, /git fetch/)
    assert.doesNotMatch(triggerWorkflow, /--backend ephemeral-runner/)
    const dispatcher = workflowJobBlock(triggerWorkflow, 'dispatch')
    assert.match(dispatcher, /github\.event\.label\.name == 'copse-review'/)
    assert.match(dispatcher, /github\.actor_id == '338988'/)
    assert.match(dispatcher, /github\.event\.pull_request\.user\.id == 338988/)
    assert.match(dispatcher, /github\.event\.pull_request\.head\.repo\.id == 1274237362/)
    assert.match(dispatcher, /actions: write/)
    assert.match(dispatcher, /pull-requests: read/)
    assert.match(dispatcher, /gh workflow run review-ground\.yml/)

    assert.match(groundWorkflow, /^ {2}workflow_dispatch:$/m)
    assert.doesNotMatch(groundWorkflow, /^ {2}issues:$/m)
    assert.doesNotMatch(groundWorkflow, /^ {2}pull_request:$/m)
    assert.doesNotMatch(groundWorkflow, /^ {2}pull_request_target:$/m)
    assert.doesNotMatch(groundWorkflow, /\$\{\{\s*secrets\./)
    const groundJobs = [
      workflowJobBlock(groundWorkflow, 'ground'),
      workflowJobBlock(nightlyWorkflow, 'ground'),
    ]
    for (const job of groundJobs) {
      assert.match(job, /permissions: \{\}/)
      assert.doesNotMatch(job, /\$\{\{\s*secrets\./)
      assert.match(job, /ref: \$\{\{ github\.(?:sha|event\.repository\.default_branch) \}\}/)
      assert.match(job, /persist-credentials: false/)
      assert.match(job, /refs\/pull\/\$\{PR_NUMBER\}\/head/)
      assert.match(job, /--backend ephemeral-runner/)
      assert.match(job, /--scratch-parent "\$RUNNER_TEMP"/)
    }

    const handoff = workflowJobBlock(groundWorkflow, 'handoff')
    assert.match(handoff, /needs: \[reuse, ground\]/)
    assert.match(handoff, /needs\.reuse\.outputs\.run_id \|\| github\.run_id/)
    const reuse = workflowJobBlock(groundWorkflow, 'reuse')
    assert.match(reuse, /actions: read/)
    assert.match(reuse, /continue-on-error: true/)
    assert.match(
      groundWorkflow,
      /if: always\(\) && !cancelled\(\) && needs\.reuse\.outputs\.run_id == ''/,
    )
    assert.doesNotMatch(reuse, /--backend|secrets\./)
    assert.match(reuse, /node packages\/review\/ci\/reuse-ground\.mts/)
    assert.match(handoff, /actions: write/)
    assert.doesNotMatch(handoff, /actions\/checkout/)
    assert.doesNotMatch(handoff, /actions\/download-artifact/)
    assert.match(handoff, /gh workflow run review-findings\.yml/)
    assert.match(handoff, /ground_run_id=\$\{GROUND_RUN_ID\}/)

    for (const job of [
      workflowJobBlock(findingsWorkflow, 'findings'),
      workflowJobBlock(nightlyWorkflow, 'findings'),
    ]) {
      assert.match(job, /--stage0-json ground\/report\.json/)
      assert.doesNotMatch(job, /--backend ephemeral-runner/)
      assert.match(job, /--backend container/)
      assert.match(job, /--image "\$REVIEW_CELL_IMAGE"/)
      assert.match(job, /--scratch-parent "\$RUNNER_TEMP"/)
      assert.match(
        job,
        /--trusted-prepare "\$GITHUB_WORKSPACE\/scripts\/prepare-review-stage0\.mts"/,
      )

      const prepare = job.indexOf('- name: Prepare the focused-validation cell')
      const mint = job.indexOf('- name: Mint the Copse GitHub App review token')
      const model = job.indexOf('COPSE_REVIEW_API_KEY:')
      assert.ok(prepare >= 0 && prepare < mint && mint < model)
      const prepareStep = job.slice(prepare, mint)
      assert.doesNotMatch(prepareStep, /\$\{\{\s*secrets\./)
    }
  })

  it('keeps complete ancestry while omitting historical blobs from review checkouts', () => {
    for (const workflow of [groundWorkflow, findingsWorkflow, nightlyWorkflow]) {
      const checkouts = workflow.matchAll(/uses: actions\/checkout[^\n]*\n([\s\S]*?)(?=\n {6}-|$)/g)
      let count = 0
      for (const [, step] of checkouts) {
        assert.match(step ?? '', /filter: blob:none/)
        assert.match(step ?? '', /fetch-depth: 0/)
        assert.match(step ?? '', /persist-credentials: false/)
        count++
      }
      assert.ok(count > 0)
    }
  })

  it('binds the findings dispatch to trusted successful ground-run metadata', () => {
    assert.ok(groundWorkflow.includes('run-name: copse-review-ground pr=${{ inputs.pr }}'))
    assert.match(findingsWorkflow, /^ {2}workflow_dispatch:$/m)
    assert.doesNotMatch(findingsWorkflow, /^ {2}workflow_run:$/m)
    assert.match(findingsWorkflow, /GROUND_RUN_ID: \$\{\{ inputs\.ground_run_id \}\}/)
    assert.match(findingsWorkflow, /actions\/runs\/\$\{GROUND_RUN_ID\}/)
    assert.match(findingsWorkflow, /test "\$conclusion" = "success"/)
    assert.match(findingsWorkflow, /test "\$path" = "\.github\/workflows\/review-ground\.yml"/)
    assert.match(findingsWorkflow, /test "\$head" = "\$EXPECTED_HEAD"/)
    assert.match(findingsWorkflow, /test "\$base" = "\$EXPECTED_BASE"/)
    assert.match(findingsWorkflow, /pulls\/\$\{number\}/)
    assert.match(findingsWorkflow, /HEAD_SHA: \$\{\{ steps\.pr\.outputs\.head \}\}/)
    assert.match(findingsWorkflow, /run-id: \$\{\{ inputs\.ground_run_id \}\}/)
  })

  it('posts GitHub reviews as the least-privilege Copse App identity', () => {
    assert.match(
      findingsWorkflow,
      /^permissions:\n {2}contents: read\n {2}pull-requests: read\n {2}actions: read$/m,
      'the default workflow token must not retain review-write permission',
    )
    const nightlyFindings = workflowJobBlock(nightlyWorkflow, 'findings')
    assert.match(
      nightlyFindings,
      /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read$/m,
    )

    for (const job of [workflowJobBlock(findingsWorkflow, 'findings'), nightlyFindings]) {
      assert.match(
        job,
        /- name: Mint the Copse GitHub App review token\n {8}id: review-app-token\n {8}uses: actions\/create-github-app-token@v3/,
      )
      assert.match(job, /app-id: \$\{\{ secrets\.RELEASE_APP_ID \}\}/)
      assert.match(job, /private-key: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}/)
      assert.match(job, /permission-pull-requests: write/)

      const postingStep = job.match(
        / {6}- name: Review with focused validation and post the findings\n[\s\S]*?(?=\n {6}- uses: actions\/upload-artifact)/,
      )?.[0]
      assert.ok(postingStep, 'expected the review generation and posting step')
      assert.match(
        postingStep,
        /COPSE_REVIEW_FORGE_TOKEN: \$\{\{ steps\.review-app-token\.outputs\.token \}\}/,
      )
      assert.doesNotMatch(
        postingStep,
        /^\s+GITHUB_TOKEN:/m,
        'the posting step must not silently fall back to the workflow identity',
      )
    }
  })

  it('primes the isolated checks from data-only files at the exact pull-request head', () => {
    for (const workflow of [groundWorkflow, nightlyWorkflow]) {
      const job = workflowJobBlock(workflow, 'ground')
      assert.match(job, /git show "\$\{HEAD_SHA\}:pnpm-lock\.yaml"/)
      assert.match(job, /git archive --format=tar "\$HEAD_SHA" patches/)
      assert.match(job, /pnpm fetch --frozen-lockfile --dir "\$dependency_seed"/)
      assert.doesNotMatch(job, /pnpm fetch[^\n]*--dir [^"$]/)
      assert.ok(job.indexOf('test "$(git rev-parse') < job.indexOf('pnpm fetch'))
      assert.ok(job.indexOf('pnpm fetch') < job.indexOf('--backend ephemeral-runner'))
      assert.match(
        job,
        /--trusted-prepare "\$GITHUB_WORKSPACE\/scripts\/prepare-review-stage0\.mts"/,
      )
    }

    for (const workflow of [findingsWorkflow, nightlyWorkflow]) {
      const job = workflowJobBlock(workflow, 'findings')
      assert.match(job, /git show "\$\{HEAD_SHA\}:pnpm-lock\.yaml"/)
      assert.match(job, /git archive --format=tar "\$HEAD_SHA" patches/)
      assert.match(job, /pnpm fetch --frozen-lockfile --dir "\$dependency_seed"/)
      assert.ok(job.indexOf('docker build --pull') < job.indexOf('refs/pull/'))
      assert.ok(job.indexOf('pnpm fetch') < job.indexOf('COPSE_REVIEW_API_KEY:'))
    }
  })

  it('builds the focused-validation image with only a test toolchain', () => {
    assert.match(reviewCellDockerfile, /^ARG NODE_VERSION=/m)
    assert.match(reviewCellDockerfile, /^FROM node:\$\{NODE_VERSION\}-trixie-slim$/m)
    assert.match(reviewCellDockerfile, /"pnpm@\$\{PNPM_VERSION\}"/)
    for (const tool of ['cargo', 'g++', 'git', 'make', 'python3', 'ripgrep', 'socat']) {
      assert.match(reviewCellDockerfile, new RegExp(`^ {6}${tool.replace('+', '\\+')} \\\\$`, 'm'))
    }
    assert.doesNotMatch(reviewCellDockerfile, /COPY|ADD|ENTRYPOINT/)
  })

  it('provisions the scrubbed Stage 0 cell with the full Linux test toolchain', () => {
    for (const workflow of [groundWorkflow, nightlyWorkflow]) {
      const job = workflowJobBlock(workflow, 'ground')
      assert.match(job, /apt-get install -y --no-install-recommends bubblewrap cargo ripgrep socat/)
      assert.match(job, /apparmor_restrict_unprivileged_userns=0/)
      assert.match(job, /bwrap --unshare-all --dev-bind \/ \/ --die-with-parent true/)
      assert.match(job, /export PATH="\$\{setup_node_bin\}:\/usr\/bin:\$\{PATH\}"/)
      assert.match(job, /test "\$\(command -v cargo\)" = \/usr\/bin\/cargo/)
      assert.match(job, /test "\$\(command -v node\)" = "\$\{setup_node_bin\}\/node"/)
      assert.ok(job.indexOf('apt-get install') < job.indexOf('refs/pull/'))
      assert.ok(job.indexOf('export PATH=') < job.indexOf('--backend ephemeral-runner'))
    }
  })

  it('retains the bounded configured Scaleway profile in model-backed reviewer workflows', () => {
    for (const workflow of [findingsWorkflow, nightlyWorkflow, modelBenchWorkflow]) {
      assert.ok(workflow.includes("COPSE_REVIEW_PROVIDER || 'openai-compatible'"))
      assert.ok(workflow.includes("COPSE_REVIEW_MODEL || 'qwen3.8-27b'"))
      assert.ok(workflow.includes("'https://api.scaleway.ai/v1'"))
      assert.ok(workflow.includes('secrets.COPSE_REVIEW_API_KEY || secrets.SCW_GENERATIVE_API_KEY'))
      assert.ok(workflow.includes('SCW_DEFAULT_PROJECT_ID: ${{ secrets.SCW_DEFAULT_PROJECT_ID }}'))
      assert.ok(workflow.includes("COPSE_REVIEW_MAX_STEPS || '12'"))
      assert.ok(workflow.includes("COPSE_REVIEW_MAX_VERIFY || '3'"))
      assert.match(workflow, /review_base_url="\$\{REVIEW_BASE_URL%\/\}"/)
      assert.ok(
        workflow.includes(
          'SCW_DEFAULT_PROJECT_ID is required for explicit Scaleway billing attribution',
        ),
      )
      assert.match(
        workflow,
        /review_base_url="https:\/\/api\.scaleway\.ai\/\$\{SCW_DEFAULT_PROJECT_ID\}\/v1"/,
      )
      assert.ok(workflow.includes('using an explicit Scaleway project endpoint'))
      assert.match(workflow, /--provider "\$REVIEW_PROVIDER"/)
      assert.match(workflow, /--base-url "\$review_base_url"/)
      assert.match(workflow, /--max-steps "\$REVIEW_MAX_STEPS"/)
      assert.match(workflow, /--max-verify "\$REVIEW_MAX_VERIFY"/)
    }
    for (const workflow of [findingsWorkflow, nightlyWorkflow]) {
      assert.ok(workflow.includes("COPSE_REVIEW_LENSES || 'correctness'"))
    }
    assert.ok(modelBenchWorkflow.includes("inputs.lenses || 'correctness,boundaries'"))
  })

  it('runs the real-model corpus manually over trusted default-branch fixtures', () => {
    assert.match(modelBenchWorkflow, /^ {2}workflow_dispatch:$/m)
    assert.doesNotMatch(modelBenchWorkflow, /^ {2}(?:pull_request|pull_request_target|schedule):/m)
    assert.match(modelBenchWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
    assert.match(modelBenchWorkflow, /persist-credentials: false/)
    assert.doesNotMatch(modelBenchWorkflow, /git fetch|refs\/pull|--stage0-json|GITHUB_TOKEN/)
    assert.match(modelBenchWorkflow, /scripts\/bench-review\.mts/)
    assert.match(modelBenchWorkflow, /--challenger "\$REVIEW_MODEL"/)
    assert.match(modelBenchWorkflow, /bench_args\+=\(--case "\$REVIEW_CASE"\)/)
    assert.match(modelBenchWorkflow, /pnpm exec node "\$\{bench_args\[@\]\}"/)
    assert.match(modelBenchWorkflow, /--out bench-results\/review-model/)
    assert.match(modelBenchWorkflow, /retention-days: 30/)
  })

  it('keeps OpenRouter experiments manual, bounded, and on their own credential', () => {
    assert.match(modelBenchWorkflow, /default: timer-leak/)
    assert.match(modelBenchWorkflow, /^ {2}group: copse-review-model-bench$/m)
    assert.match(modelBenchWorkflow, /timeout-minutes: 60/)
    assert.match(
      modelBenchWorkflow,
      /OPENROUTER_API_KEY: \$\{\{ secrets\.COPSE_REVIEW_OPENROUTER_API_KEY \}\}/,
    )
    assert.match(modelBenchWorkflow, /openrouter-luna\|openrouter-sol\)/)
    assert.match(modelBenchWorkflow, /unset COPSE_REVIEW_API_KEY SCW_DEFAULT_PROJECT_ID/)
    assert.match(modelBenchWorkflow, /if test -z "\$OPENROUTER_API_KEY"; then/)
    assert.match(modelBenchWorkflow, /REVIEW_PROVIDER=openrouter/)
    assert.match(
      modelBenchWorkflow,
      /REVIEW_MODEL="openai\/gpt-6-\$\{REVIEW_PROFILE#openrouter-\}"/,
    )
    assert.match(modelBenchWorkflow, /REVIEW_MAX_STEPS=12/)
    assert.match(modelBenchWorkflow, /REVIEW_MAX_VERIFY=3/)
    for (const workflow of [findingsWorkflow, nightlyWorkflow]) {
      assert.doesNotMatch(workflow, /openrouter-sol/)
    }
  })

  it('permits only the owner to dispatch or rerun the trusted main-branch benchmark', () => {
    const job = workflowJobBlock(modelBenchWorkflow, 'benchmark')
    const guard = job.match(/^ {4}if: >-\n((?: {6}.+\n)+)/m)?.[1]?.trim()
    assert.ok(guard)
    assert.ok(guard.startsWith('${{ ') && guard.endsWith(' }}'))
    // Evaluate the actual workflow's deliberately small equality/conjunction
    // grammar. Unknown syntax fails the test instead of silently approximating
    // an Actions expression or executing it as JavaScript.
    const clauses = guard
      .slice(4, -3)
      .split('&&')
      .map((clause) => {
        const match = /^github\.([a-z_]+)\s*==\s*'([^']+)'$/.exec(clause.trim())
        assert.ok(match, `unsupported access expression: ${clause}`)
        const [, key, value] = match
        assert.ok(key && value)
        return { key, value }
      })
    const allowed = (context: Readonly<Record<string, string>>): boolean =>
      clauses.every(({ key, value }) => context[key]?.toLowerCase() === value.toLowerCase())
    const owner = {
      repository_id: '1274237362',
      event_name: 'workflow_dispatch',
      ref: 'refs/heads/main',
      workflow_ref: 'copse-dev/agent-pane/.github/workflows/review-model-bench.yml@refs/heads/main',
      actor_id: '338988',
      triggering_actor: 'jonathanKingston',
    }
    assert.equal(allowed(owner), true)
    for (const event of [
      'pull_request',
      'pull_request_target',
      'workflow_run',
      'push',
      'schedule',
    ]) {
      assert.equal(allowed({ ...owner, event_name: event }), false, event)
    }
    assert.equal(allowed({ ...owner, repository_id: '999' }), false, 'fork repository')
    assert.equal(allowed({ ...owner, actor_id: '999' }), false, 'outside original actor')
    assert.equal(allowed({ ...owner, triggering_actor: 'contributor' }), false, 'outside rerun')
    assert.equal(allowed({ ...owner, ref: 'refs/heads/contributor' }), false, 'branch dispatch')
    assert.equal(allowed({ ...owner, ref: 'refs/tags/main' }), false, 'same-name tag')
    assert.equal(
      allowed({
        ...owner,
        workflow_ref: owner.workflow_ref.replace('/heads/main', '/heads/contributor'),
      }),
      false,
      'untrusted workflow ref',
    )
    assert.equal(allowed({}), false, 'missing context')
    assert.match(job, /^ {4}environment: copse-review-models$/m)
  })

  it('references the environment key only in protected reviewer model steps and never the org key', () => {
    const secret = 'secrets.COPSE_REVIEW_OPENROUTER_API_KEY'
    const workflows = readdirSync(resolve('.github/workflows')).filter((name) =>
      /\.ya?ml$/.test(name),
    )
    for (const name of workflows) {
      const workflow = readFileSync(resolve('.github/workflows', name), 'utf8')
      assert.doesNotMatch(
        workflow,
        /secrets(?:\.OPENROUTER_API_KEY|\[['"]OPENROUTER_API_KEY['"]\])/,
        name,
      )
      if (!['review-model-bench.yml', 'review-findings.yml', 'review-nightly.yml'].includes(name)) {
        assert.ok(!workflow.includes(secret), name)
      }
    }
    assert.equal(modelBenchWorkflow.split(secret).length - 1, 1)
    const install = modelBenchWorkflow.indexOf('- name: Install the reviewer')
    const model = modelBenchWorkflow.indexOf('- name: Run the advisory real-model benchmark')
    const credential = modelBenchWorkflow.indexOf(secret)
    const upload = modelBenchWorkflow.indexOf('- uses: actions/upload-artifact')
    assert.ok(install < model && model < credential && credential < upload)
    for (const workflow of [findingsWorkflow, nightlyWorkflow]) {
      const findings = workflowJobBlock(workflow, 'findings')
      assert.equal(workflow.split(secret).length - 1, 1)
      assert.match(findings, /^ {4}environment: copse-review-models$/m)
      const prepare = findings.indexOf('- name: Prepare the focused-validation cell')
      const review = findings.indexOf(
        '- name: Review with focused validation and post the findings',
      )
      const key = findings.indexOf(secret)
      assert.ok(prepare >= 0 && prepare < review && review < key)
      assert.match(findings, /unset COPSE_REVIEW_API_KEY SCW_DEFAULT_PROJECT_ID/)
      assert.match(findings, /configured\) unset OPENROUTER_API_KEY/)
      assert.match(findings, /test "\$author_id" = 338988/)
      assert.match(findings, /test "\$head_repo_id" = 1274237362/)
      assert.match(findings, /test "\$base_repo_id" = 1274237362/)
    }
  })

  it('samples at most one recent same-repository PR, including drafts, and has an explicit opt-out', () => {
    assert.match(nightlyWorkflow, /^ {2}schedule:$/m)
    assert.match(nightlyWorkflow, /^ {2}workflow_dispatch:$/m)
    assert.match(nightlyWorkflow, /pull\.head\.repo\?\.full_name === `\$\{owner\}\/\$\{repo\}`/)
    assert.match(nightlyWorkflow, /14 \* 24 \* 60 \* 60 \* 1000/)
    assert.match(nightlyWorkflow, /!labels\.includes\('copse-review'\)/)
    assert.match(nightlyWorkflow, /!labels\.includes\('copse-review-skip'\)/)
    assert.match(nightlyWorkflow, /selected = candidates\[utcDay % candidates\.length\]/)
    assert.doesNotMatch(nightlyWorkflow, /!pull\.draft/)
    assert.doesNotMatch(nightlyWorkflow, /selected\.draft/)
    assert.doesNotMatch(nightlyWorkflow, /^ {2}pull_request:/m)
  })

  it('keeps reviews advisory and retains machine-readable dogfood evidence', () => {
    assert.match(forgeReview, /event: 'COMMENT'/)
    assert.doesNotMatch(forgeReview, /REQUEST_CHANGES/)
    for (const workflow of [findingsWorkflow, nightlyWorkflow]) {
      assert.match(workflow, /--json findings\.json/)
      assert.match(workflow, /--sarif findings\.sarif/)
      assert.match(workflow, /retention-days: 30/)
    }
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

// Every branch publishes into the one demo-previews branch, and an update to
// main fans this workflow out into a dozen runs at once, so most of them lose
// the race and restack onto the winner. The retry policy decides whether that
// is invisible or surfaces as a red X on a PR whose contents were never wrong —
// and a check that fails for reasons unrelated to the PR is one people learn to
// ignore. Each property below is one "simplification" away from coming back.
describe('demo preview publish race invariants', () => {
  const demoPreview = readFileSync(resolve('.github/workflows/demo-preview.yml'), 'utf8')

  it('jitters the backoff, so a herd does not retry in lockstep', () => {
    const sleep = demoPreview.match(/^ *sleep \$\(\(.*\)\)$/m)?.[0]
    assert.ok(sleep, 'expected the restack backoff sleep')
    assert.match(
      sleep,
      /RANDOM/,
      'a fixed backoff retries every racing run at the same instant, so they collide again',
    )
  })

  it('allows more attempts than the herd is deep, and reports the real ceiling', () => {
    const attempts = Number(demoPreview.match(/^ *attempts=(\d+)$/m)?.[1])
    assert.ok(
      attempts >= 10,
      `one main update fans out into ~13 runs that drain one per round; ${String(attempts)} is short`,
    )
    assert.match(
      demoPreview,
      /Could not publish \$\{LABEL\} to demo-previews after \$\{attempts\} attempts/,
      'the failure message has to track the ceiling, not a number an edit left behind',
    )
  })

  it('re-applies the built tree on a retry rather than rebuilding it', () => {
    // A retry changes which tip the target sits on, never what it publishes.
    // Rebuilding widens the gap between fetching that tip and pushing, which is
    // precisely the window the run has to win.
    assert.equal(
      demoPreview.match(/cp -R dist\/demo\/\./g)?.length,
      1,
      'the demo copy belongs to the build-once branch, not to every attempt',
    )
    assert.match(demoPreview, /git -C previews-branch checkout "\$restack_from" -- "\$path"/)
  })
})

// Every deploy serializes on the shared `pages` group, which keeps ONE pending
// slot: a newer pending deploy cancels the older one. While demo-preview.yml
// reached that queue through `uses:`, the cancelled job was part of the PR's own
// run, so the run went cancelled and the PR grew a grey X — on 23 of the 40 runs
// before this changed, every one of them a preview that had already published
// and commented. Dispatching moves the supersession onto a run no PR watches.
// One `uses:` away from coming back, and nothing but the Actions tab shows it.
describe('demo preview deploy decoupling invariants', () => {
  const demoPreview = readFileSync(resolve('.github/workflows/demo-preview.yml'), 'utf8')

  it('never puts a PR run in the pages deploy queue', () => {
    assert.doesNotMatch(
      demoPreview,
      /^\s*uses: \.\/\.github\/workflows\/pages\.yml/m,
      "a called workflow's jobs run inside this run, so its cancellation cancels the PR's preview run",
    )
  })

  it('dispatches the deploy on the pushed branch instead', () => {
    assert.match(demoPreview, /createWorkflowDispatch/)
    assert.match(
      demoPreview,
      /^ {4}permissions:\n {6}actions: write$/m,
      'dispatching needs actions: write; the deploy scopes belong to the dispatched run',
    )
    // The branch, not `main`: `uses:` resolved pages.yml from the pushed branch,
    // so a PR editing the deploy exercised its own copy before merge.
    assert.match(
      demoPreview,
      /ref: context\.ref\.replace\('refs\/heads\/', ''\)|const ref = context\.ref\.replace/,
    )
  })

  it('skips the dispatch only for a deploy that has not assembled yet', () => {
    // A queued deploy reads the demo-previews tip when it starts, so it carries
    // the commit `publish` just pushed. An in-progress one may have fetched that
    // tip already, so it is NOT evidence this build will be published.
    const guard = demoPreview.match(/const pending = data\.workflow_runs\.find\(\n[\s\S]*?\);/)?.[0]
    assert.ok(guard, 'expected the queued-deploy guard before the dispatch')
    assert.doesNotMatch(
      guard,
      /'in_progress'/,
      'an in-progress deploy may predate this push; skipping on it drops the preview',
    )
    assert.match(guard, /'queued'/)
    assert.match(guard, /'pending'/)
  })

  it('warns rather than fails when the deploy cannot be dispatched', () => {
    // What `tolerate-deploy-failure: true` bought on the old `uses:` call, and
    // the reason it is not just defensive: a PR that merges while its preview is
    // still building takes its head branch with it, so the dispatch ref 404s.
    // Failing there paints a red X on an already-merged PR.
    assert.match(
      demoPreview,
      /catch \(err\) \{\n\s*core\.warning\(/,
      "a deploy problem is never the PR's fault; the build is already on demo-previews",
    )
    assert.doesNotMatch(
      demoPreview,
      /core\.setFailed/,
      'failing this job puts the deploy queue back on the PR, which is what this job exists to stop',
    )
  })
})

// Previews and demos are published under the production domain, so search
// engines must be told to skip them — and told *only* about them. Both halves
// are one-line changes away from silently inverting: a marker dropped from a
// publish step ships an indexable preview, a tag added to site/ de-indexes
// copse.dev itself. Nothing but a crawl would ever reveal either.
describe('preview noindex invariants', () => {
  const demoPreview = readFileSync(resolve('.github/workflows/demo-preview.yml'), 'utf8')
  const build = readFileSync(resolve('scripts/build.mts'), 'utf8')
  const robots = readFileSync(resolve('site/robots.txt'), 'utf8')

  it('marks both marketing-site bundles published under /demo/', () => {
    // main/preview and pr-<n>-preview are copies of site/, so the tag has to be
    // applied to the copy — the source stays indexable for the root deploy.
    assert.match(demoPreview, /mark_bundle_noindex "\$\{TARGET\}\/preview"/)
    assert.match(demoPreview, /mark_bundle_noindex "\$bundle_target"/)
    assert.match(demoPreview, /node scripts\/mark-noindex\.mts/)
  })

  it('marks the demo build itself, so the tag travels with the artifact', () => {
    assert.match(build, /markTreeNoindex\(rendererOutDir\)/)
    // Inside the isDemo block: the packaged app has no crawler, and marking the
    // shipped renderer would be noise in the release bundle.
    const demoBlock = build.match(/^if \(isDemo\) \{\n[\s\S]*?^\}$/m)?.[0]
    assert.ok(demoBlock, 'expected the `if (isDemo)` block in build.mts')
    assert.match(demoBlock, /markTreeNoindex\(rendererOutDir\)/)
  })

  it('leaves the production marketing site indexable', () => {
    for (const name of readdirSync(resolve('site')).filter((f) => f.endsWith('.html'))) {
      assert.doesNotMatch(
        readFileSync(resolve('site', name), 'utf8'),
        /name=["']robots["']/i,
        `site/${name} is deployed to the copse.dev root from main — it must stay indexable`,
      )
    }
  })

  it('does not disallow /demo/ in robots.txt, which would hide the noindex', () => {
    // A disallowed URL is never fetched, so its noindex is never read and the
    // URL can stay indexed on the strength of inbound links alone (the sticky
    // PR comment is public). Crawling is how the tag gets honoured.
    assert.doesNotMatch(robots, /^\s*Disallow:\s*\/demo/im)
    assert.doesNotMatch(robots, /^\s*Disallow:\s*\/\s*$/im)
  })
})
