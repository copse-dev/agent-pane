import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { readShardWeights } from './test-oracle.mts'

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

  // Cosmetic event admission, check names, and concurrency are evaluated from
  // the parsed workflow in ci-cosmetic-events.test.ts.

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

  function shardSpecs(mode: 'full' | 'subset', shard: number, total: number, specs = ''): string[] {
    const job = jobBlock('e2e')
    const start = job.indexOf('          if [ "$PLAN_MODE" = "full" ]; then')
    const end = job.indexOf('          # `timeout`', start)
    assert.ok(start >= 0 && end > start, 'expected the real shard-selection shell')
    const script = job.slice(start, end).replaceAll('${{ matrix.shard }}', String(shard))
    const result = spawnSync(
      'bash',
      ['-eu', '-c', `${script}\nprintf '\nSELECTED:%s\n' "$SPEC_ARGS"`],
      {
        encoding: 'utf8',
        env: { ...process.env, PLAN_MODE: mode, PLAN_SPECS: specs, SHARD_TOTAL: String(total) },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    const selected = result.stdout.match(/^SELECTED:(.*)$/m)?.[1]?.trim()
    if (!selected) return []
    const args = selected.split(/\s+/)
    assert.ok(args.every((arg, index) => index % 2 === 1 || arg === '--spec'))
    return args.filter((_arg, index) => index % 2 === 1)
  }

  it('balances the full eligible suite by recorded duration without losing coverage', () => {
    const listed = spawnSync(process.execPath, ['scripts/test-oracle.mts', '--list-ci-specs'], {
      encoding: 'utf8',
    })
    assert.equal(listed.status, 0, listed.stderr)
    const expected = listed.stdout.trim().split('\n')
    assert.ok(expected.includes('tests/e2e/vnc-viewer.e2e.ts'))
    assert.ok(!expected.includes('tests/e2e/agent-eval-drive.e2e.ts'))
    assert.ok(!expected.includes('tests/e2e/staged-diff-ui.e2e.ts'))
    const buckets = Array.from({ length: 8 }, (_unused, index) => shardSpecs('full', index + 1, 8))
    assert.deepEqual(buckets.flat().sort(), expected, 'every eligible spec runs exactly once')
    // The 720s attempt watchdog needs headroom on every shard, not on average:
    // round-robin by count let the slowest shard run ~180s past the fastest.
    // This bound replaces #3355's rule that the explainer specs never share a
    // worker, which stood in for it.
    const weights = readShardWeights()
    const loads = buckets.map((bucket) =>
      bucket.reduce((sum, spec) => sum + (weights.get(spec) ?? 0), 0),
    )
    assert.ok(
      Math.max(...loads) - Math.min(...loads) < 30,
      `recorded shard durations should be within 30s: ${loads.map(Math.round).join(', ')}`,
    )
  })

  it('records a duration for every spec the full suite runs', () => {
    const weights = readShardWeights()
    const listed = spawnSync(process.execPath, ['scripts/test-oracle.mts', '--list-ci-specs'], {
      encoding: 'utf8',
    })
    const missing = listed.stdout
      .trim()
      .split('\n')
      .filter((spec) => !weights.has(spec))
    // A new spec is placed at the median weight, so a few gaps are harmless;
    // many mean the weights are stale and the balance is drifting.
    assert.ok(
      missing.length <= 20,
      `run \`pnpm run e2e:shard-weights\` to record ${String(missing.length)} unweighted specs`,
    )
  })

  it('keeps subset plans scoped and safely handles an empty slice', () => {
    const specs = 'tests/e2e/a.e2e.ts tests/e2e/b.e2e.ts tests/e2e/c.e2e.ts'
    assert.deepEqual(shardSpecs('subset', 1, 2, specs), [
      'tests/e2e/a.e2e.ts',
      'tests/e2e/c.e2e.ts',
    ])
    assert.deepEqual(shardSpecs('subset', 2, 2, specs), ['tests/e2e/b.e2e.ts'])
    assert.deepEqual(shardSpecs('subset', 1, 1), [])
  })

  it('fetches one commit history instead of every branch and tag', () => {
    // `fetch-depth: 0` fetched ~575 branches (mostly screenshot-compare/*) and
    // every tag: 2.3 GB, against ~1 GB for the checked-out commit's history.
    assert.doesNotMatch(workflow, /^ +fetch-depth: 0$/m)
    for (const job of ['precheck', 'autoformat', 'screenshot-artifacts'])
      assert.match(
        jobBlock(job),
        /git fetch --no-tags --quiet --unshallow origin "\$\(git rev-parse HEAD\)"/,
        `${job} needs its full history for the diffs it takes against a base`,
      )
    // The autofix diff is `BASE_SHA...HEAD` on the head branch, and the
    // screenshot filter scopes against origin/main: both need that branch too.
    assert.match(
      jobBlock('autoformat'),
      /"\+refs\/heads\/\$\{BASE_REF\}:refs\/remotes\/origin\/\$\{BASE_REF\}"/,
    )
    assert.match(
      jobBlock('screenshot-artifacts'),
      /'\+refs\/heads\/main:refs\/remotes\/origin\/main'/,
    )
  })

  it('fetches the oracle base unshallowed so a force-pushed `before` keeps its merge-base', () => {
    // `--depth=1` into the full history marks BASE_SHA a shallow boundary: a
    // push whose `before` was force-replaced then shares no merge-base with
    // HEAD. The oracle fails closed on that (full plan), but a normal fetch
    // keeps such a push scoped at the cost of only the replaced commits.
    const precheck = jobBlock('precheck')
    assert.doesNotMatch(precheck, /git fetch[^\n]*--depth[^\n]*"\$BASE_SHA"/)
    const fetch = precheck.indexOf('git fetch --no-tags origin "$BASE_SHA"')
    const oracle = precheck.indexOf('node scripts/test-oracle.mts --plan --base "$BASE_SHA"')
    assert.ok(fetch >= 0 && oracle > fetch, 'the plan step must fetch BASE_SHA before the oracle')
  })

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
    assert.match(e2eJob, /github\.event_name == 'merge_group'/, 'queue e2e needs a valid runner')
    assert.match(e2eJob, /fromJSON\('\["self-hosted", "copse-e2e"\]'\)/)
    // Fails closed for forks: no branch of the expression yields a runner for
    // an untrusted event, not even a free hosted one.
    assert.doesNotMatch(
      e2eJob,
      /head\.repo\.full_name != github\.repository/,
      'e2e must have no fork branch at all — the `if` guard skips forks and the runner expression fails closed',
    )
  })

  it('pins every queue candidate runner to hosted even when both fleets are opted in', () => {
    // Run the actual routing expressions with opt-in values, rather than just
    // checking that a merge_group clause appears somewhere in the job.
    const optedIn = {
      SELF_HOSTED_CHECKS: 'copse-checks',
      SELF_HOSTED_E2E: 'copse-e2e',
      LM_EVAL_RUNNER: 'private-model-fleet',
    }
    const route = (name: string, event: string, sameRepo: boolean): unknown => {
      const job = jobBlock(name)
      const binding = job.match(/^ {4}runs-on: (.+)$/m)?.[1]
      assert.ok(binding, `${name} needs a runner`)
      if (binding === 'ubuntu-latest') return binding
      const folded = job.match(/^ {4}runs-on: >-\n((?: {6}.+\n)+)/m)?.[1]
      const expression = (folded ?? binding).trim()
      assert.ok(expression.startsWith('${{ ') && expression.endsWith(' }}'))
      // These routing expressions use only equality, boolean short-circuiting,
      // context member reads and fromJSON. Unsupported constructs fail here.
      const source = expression.slice(4, -3)
      assert.match(source, /^[a-zA-Z0-9_.'"[\], ()&|=!\s-]+$/)
      const result: unknown = runInNewContext(
        source,
        {
          github: {
            event_name: event,
            repository: 'copse-dev/agent-pane',
            event: {
              pull_request: {
                head: {
                  repo: { full_name: sameRepo ? 'copse-dev/agent-pane' : 'fork/agent-pane' },
                },
              },
            },
          },
          vars: optedIn,
          fromJSON: (value: string): unknown => JSON.parse(value),
        },
        { timeout: 100 },
      )
      // Normalize arrays across VM realms without trusting their element type.
      return Array.isArray(result) ? Array.from(result) : result
    }
    const checkRoutes = [...workflow.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
      .flatMap((match) => (match[1] ? [match[1]] : []))
      .filter((name) => jobBlock(name).includes('vars.SELF_HOSTED_CHECKS'))
    assert.ok(checkRoutes.includes('precheck') && checkRoutes.includes('build'))
    for (const name of checkRoutes) {
      for (const sameRepo of [false, true]) {
        assert.equal(route(name, 'merge_group', sameRepo), 'ubuntu-latest', name)
      }
      assert.equal(route(name, 'push', true), 'copse-checks', `${name} retains trusted opt-in`)
    }
    assert.equal(route('precheck', 'pull_request', false), 'ubuntu-latest')
    assert.equal(route('precheck', 'pull_request', true), 'copse-checks')
    for (const sameRepo of [false, true]) {
      assert.deepEqual(route('e2e', 'merge_group', sameRepo), ['ubuntu-latest'])
    }
    assert.deepEqual(route('e2e', 'schedule', true), ['ubuntu-latest'])
    assert.deepEqual(route('e2e', 'push', true), ['self-hosted', 'copse-e2e'])
    assert.equal(route('e2e', 'pull_request', false), false)
  })

  it('keeps queue candidate jobs read-only and excludes privileged model and write jobs', () => {
    assert.match(workflow, /^permissions:\n {2}contents: read$/m)
    for (const name of ['precheck', 'check', 'bench', 'build', 'e2e', 'review-cell']) {
      const job = jobBlock(name)
      assert.doesNotMatch(job, /secrets\.|contents: write|statuses: write|pull-requests: write/)
      const credentials = job.match(/persist-credentials: ([^\n]+)/)?.[1]
      assert.ok(credentials, `${name} must explicitly prevent persisting queue credentials`)
      assert.ok(
        credentials === 'false' || credentials.includes("github.event_name != 'merge_group'"),
      )
    }
    for (const name of [
      'bench-agent-model',
      'doctrine-eval-model',
      'eval-tool-preference',
      'scratch-path-eval-model',
    ]) {
      const job = jobBlock(name)
      assert.match(job, /if: >-\n {6}github\.event_name != 'merge_group' &&\n/)
      assert.match(job, /secrets\.LM_STUDIO_API_KEY/)
    }
    const jobs = [...workflow.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    )
    for (const name of jobs) {
      const job = jobBlock(name)
      if (!job.includes('secrets.')) continue
      assert.ok(
        /^ {4}if: (?:>-\n {6})?github\.event_name == 'pull_request' &&/m.test(job) ||
          /if: >-\n {6}github\.event_name != 'merge_group' &&\n/.test(job),
        `${name} must reject queue events before any secret-bearing steps`,
      )
    }
    assert.match(jobBlock('autoformat'), /if: (?:>-\n {6})?github\.event_name == 'pull_request' &&/)
    assert.match(jobBlock('screenshot-artifacts'), /github\.event_name == 'pull_request'/)
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
    assert.match(
      planStep,
      /BASE_REF: \$\{\{ github\.base_ref \|\| github\.event\.merge_group\.base_ref \}\}/,
    )
    assert.match(planStep, /BASE_REF="\$\{BASE_REF#refs\/heads\/\}"/)

    const promotionGate = planStep.indexOf('[ "$BASE_REF" = "release" ]; then')
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
      /E2E_REQUIRED: \$\{\{ github\.event_name == 'merge_group' \|\| \(github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
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

  it('runs the strict streaming motion eval once after the parallel browser suite', () => {
    const build = jobBlock('build')
    const commands = [...build.matchAll(/^ {6}- run: (npm run test:demo.*)$/gm)].map(
      (match) => match[1],
    )
    assert.deepEqual(commands, [
      'npm run test:demo -- --exclude tests/demo/streamed-reply-motion.demo.ts',
      'npm run test:demo -- --spec tests/demo/streamed-reply-motion.demo.ts --maxInstances 1',
    ])
    const motion = readFileSync(resolve('tests/demo/streamed-reply-motion.demo.ts'), 'utf8')
    assert.match(motion, /expect\(motion\.maxScrollStepPx\)\.toBeLessThanOrEqual\(24\)/)
    assert.match(build, /needs: precheck/, 'keep static and build jobs parallel')
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

  it('never pushes a format commit to a promotion into release', () => {
    // The promotion head, promote/main, must hold only commits already on main.
    assert.match(
      jobBlock('autoformat'),
      /^ {4}if: (?:>-\n {6})?.*github\.base_ref != 'release' && /m,
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

  it('accepts ignored-only autofix diffs while still formatting source and rejecting parse errors', () => {
    const commands = [...jobBlock('autoformat').matchAll(/npx oxfmt ([^\n]+)/g)]
    assert.equal(commands.length, 2, 'exercise both the initial formatter run and its OOM retry')
    const root = mkdtempSync(join(tmpdir(), 'copse-autoformat-'))
    const formatter = resolve('node_modules/.bin/oxfmt')
    try {
      writeFileSync(join(root, '.prettierignore'), 'package-lock.json\n')
      const lockfile = '{ "generated":true }\n'
      writeFileSync(join(root, 'package-lock.json'), lockfile)
      for (const command of commands) {
        assert.equal(command[1]?.endsWith('-- "${files[@]}"'), true)
        const options = command[1].split(' -- ')[0]?.split(' ')
        assert.ok(options)
        const run = (files: string[]): SpawnSyncReturns<string> =>
          spawnSync(formatter, [...options, '--', ...files], { cwd: root, encoding: 'utf8' })
        const ignored = run(['package-lock.json'])
        assert.equal(ignored.status, 0, ignored.stderr)
        writeFileSync(join(root, 'source.json'), '{"source":true}\n')
        const mixed = run(['package-lock.json', 'source.json'])
        assert.equal(mixed.status, 0, mixed.stderr)
        assert.equal(readFileSync(join(root, 'source.json'), 'utf8'), '{ "source": true }\n')
        assert.equal(readFileSync(join(root, 'package-lock.json'), 'utf8'), lockfile)
        writeFileSync(join(root, 'source.json'), '{ invalid json\n')
        const malformed = run(['package-lock.json', 'source.json'])
        assert.notEqual(malformed.status, 0, 'real formatter errors must still fail the job')
        assert.equal(malformed.error, undefined)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  it('requests checks on synthetic merge groups', () => {
    assert.match(workflow, /^ {2}merge_group:\n {4}types: \[checks_requested\]/m)
    const aggregate = jobBlock('ci-passed')
    assert.match(aggregate, /MERGE_GROUP: \$\{\{ github\.event_name == 'merge_group' \}\}/)
    assert.match(aggregate, /BUILD_RESULT: \$\{\{ needs\.build\.result \}\}/)
  })

  it('uses the queue base SHA for every precheck comparison', () => {
    const precheck = jobBlock('precheck')
    const binding =
      'BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}'
    assert.equal(precheck.split(binding).length - 1, 3)
    const plan = precheck.slice(precheck.indexOf('- id: plan'))
    assert.match(plan, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
    assert.doesNotMatch(plan, /HEAD_SHA: [^\n]*merge_group/)
    assert.match(plan, /node scripts\/test-oracle\.mts --plan --base "\$BASE_SHA"/)
  })

  it('keeps main queue oracle selection and forces full release queue plans', () => {
    const planStep = workflow.match(/ {6}- id: plan\n[\s\S]*?(?=\n {6}- name: Plan reference)/)?.[0]
    assert.ok(planStep)
    const script = planStep.slice(planStep.indexOf('        run: |\n') + '        run: |\n'.length)
    for (const base of ['main', 'release']) {
      const root = mkdtempSync(join(tmpdir(), 'queue-plan-'))
      try {
        const output = join(root, 'output')
        const trace = join(root, 'oracle-trace')
        const result = spawnSync(
          'bash',
          [
            '-eu',
            '-c',
            `git() { return 0; }\nnode() { printf '%s\\n' "$*" > "$TRACE"; printf 'mode=subset\\nspecs=tests/e2e/example.e2e.ts\\nunit_mode=full\\n'; }\n${script}`,
          ],
          {
            encoding: 'utf8',
            cwd: root,
            env: {
              ...process.env,
              EVENT: 'merge_group',
              BASE_REF: `refs/heads/${base}`,
              BASE_SHA: 'queue-base-sha',
              HEAD_SHA: '',
              UPDATE_SCREENSHOTS_LABEL: 'false',
              CI_FULL_LABEL: 'false',
              GITHUB_OUTPUT: output,
              GITHUB_STEP_SUMMARY: join(root, 'summary'),
              TRACE: trace,
            },
          },
        )
        assert.equal(result.status, 0, result.stderr)
        const plan = readFileSync(output, 'utf8')
        assert.match(plan, /unit_mode=full/)
        if (base === 'main') {
          assert.match(plan, /mode=subset/)
          assert.equal(
            readFileSync(trace, 'utf8').trim(),
            'scripts/test-oracle.mts --plan --base queue-base-sha',
          )
        } else {
          assert.match(plan, /mode=full/)
          assert.equal(existsSync(trace), false, 'release queue must bypass oracle thinning')
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it('compares the synthetic checked-out protocol against the supplied queue base', () => {
    const precheck = jobBlock('precheck')
    const step = precheck.slice(precheck.indexOf('- name: API protocol compatibility'))
    const run = step.match(/run: \|\n([\s\S]*?)(?=\n {6}#|\n {6}-)/)?.[1]
    assert.ok(run)
    const result = spawnSync(
      'bash',
      [
        '-eu',
        '-c',
        `git() { return 0; }\nnode() { printf 'PROTOCOL:%s:%s:%s\\n' "$1" "$2" "$3"; }\n${run}`,
      ],
      { encoding: 'utf8', env: { BASE_SHA: 'queue-base-sha', GITHUB_EVENT_NAME: 'merge_group' } },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(
      result.stdout,
      /PROTOCOL:scripts\/gen-api-protocol\.mts:--compare-ref:queue-base-sha/,
    )
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
      'fork runs receive secrets on workflow_run and must be rejected before any write',
    )
    assert.match(
      workflow,
      /^permissions:\n {2}actions: read\n {2}contents: read\n {2}pull-requests: read$/m,
    )
  })

  it('binds publication to one open parent at the exact rendered head', () => {
    assert.match(workflow, /candidates\.length !== 1/)
    assert.match(workflow, /parent\.state !== 'open'/)
    assert.match(workflow, /parent\.head\.repo\?\.full_name === `\$\{owner\}\/\$\{repo\}`/)
    assert.match(workflow, /\['main', 'promote\/main', 'release'\]\.includes\(parent\.head\.ref\)/)
    assert.match(workflow, /parent\.head\.sha !== runHeadSha/)
    assert.match(workflow, /artifact\.name === artifactName && !artifact\.expired/)
    assert.match(workflow, /ref: \$\{\{ steps\.discover\.outputs\.head-sha \}\}/)
    assert.match(workflow, /persist-credentials: false/)
    assert.match(
      workflow,
      /parent\.head\.sha !== process\.env\.EXPECTED_HEAD_SHA\) \{\n {14}if \(compareUrl\) \{[\s\S]*?deleteRef[\s\S]*?return;/,
      'a parent-head race must remove the just-pushed compare branch and post nothing',
    )
  })

  it('accepts only bounded, flat, real PNG candidates', () => {
    assert.match(workflow, /find "\$CANDIDATE_ROOT" -type l/)
    assert.match(workflow, /tests\/e2e\/screenshots\/\*\.png\)/)
    assert.match(workflow, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\\\.png\$/)
    assert.match(workflow, /89504e470d0a1a0a/)
    assert.match(workflow, /"\$size" -gt 16777216/)
    assert.match(workflow, /"\$count" -gt 4096/)
    assert.match(workflow, /"\$total" -gt 536870912/)
    assert.match(workflow, /Unexpected file in screenshot candidate artifact/)
  })

  it('budgets for a full refresh of every committed reference with headroom', () => {
    // `update-screenshots` renders every reference into the candidate artifact,
    // so a budget below the reference set fails every labelled refresh.
    const count = Number(/"\$count" -gt (\d+)/.exec(workflow)?.[1])
    const total = Number(/"\$total" -gt (\d+)/.exec(workflow)?.[1])
    const references = readdirSync('tests/e2e/screenshots').filter((name) => name.endsWith('.png'))
    const bytes = references.reduce(
      (sum, name) => sum + statSync(resolve('tests/e2e/screenshots', name)).size,
      0,
    )
    assert.ok(
      count >= 2 * references.length,
      `count budget ${String(count)} < 2 × ${String(references.length)}`,
    )
    assert.ok(total >= 2 * bytes, `size budget ${String(total)} < 2 × ${String(bytes)} bytes`)
  })

  it('never opens a PR or mints an App token; screenshot changes are viewed via the compare branch', () => {
    // `update-screenshots` only makes CI render the full reference set. An App
    // token's pushes and PRs start workflows, and a child PR is review noise,
    // so the publisher must not regain either.
    assert.doesNotMatch(workflow, /create-pull-request|create-github-app-token|app-token/)
    assert.doesNotMatch(workflow, /secrets\./)
    assert.doesNotMatch(workflow, /rest\.pulls\.create\b/)
    assert.doesNotMatch(workflow, /review-branch|create-review/)
    assert.match(workflow, /<!-- copse-e2e-screenshot-review -->/)
    assert.match(workflow, /Close legacy screenshot review PRs/)
    assert.match(workflow, /git cherry-pick \$\{commit\}/)
  })

  it('gates the parent head on a blocking screenshot review status', () => {
    assert.match(
      workflow,
      /^ {4}permissions:\n {6}actions: read\n {6}contents: write\n {6}pull-requests: write\n {6}statuses: write$/m,
    )
    assert.match(workflow, /const statusContext = 'Screenshot review';/)
    assert.match(workflow, /- name: Fail the screenshot review closed\n {8}if: failure\(\)/)
    assert.ok(existsSync(resolve('.github/workflows/screenshot-review-labels.yml')))
  })

  it('pushes a view-only compare branch with the job token', () => {
    // Every eligible run with candidates gets a compare view. GITHUB_TOKEN
    // pushes start no workflows, so the branch never runs CI.
    assert.match(workflow, /\/\^\[0-9a-f\]\{40\}\$\/\.test\(runHeadSha/)
    assert.match(
      workflow,
      /`screenshot-compare\/pr-\$\{number\}\/\$\{runHeadSha\.slice\(0, 12\)\}`/,
    )
    assert.match(workflow, /PUSH_TOKEN: \$\{\{ github\.token \}\}/)
    assert.doesNotMatch(workflow, /persist-credentials: true/)
    assert.match(workflow, /fetch-depth: 1\n/)
    assert.match(
      workflow,
      /compare\/\$\{process\.env\.EXPECTED_HEAD_SHA\}\.\.\.\$\{process\.env\.COMPARE_BRANCH\}/,
    )
    assert.match(
      workflow,
      /parent\.head\.sha !== process\.env\.EXPECTED_HEAD_SHA\) \{\n {14}if \(process\.env\.COMPARE_PUSHED === 'true'\) await deleteBranch\(current\);/,
      'a stale publisher may delete only the compare branch it pushed',
    )
  })
})

describe('close-orphaned-screenshot-reviews.yml workflow invariants', () => {
  const workflow = readFileSync(
    resolve('.github/workflows/close-orphaned-screenshot-reviews.yml'),
    'utf8',
  )

  it('cleans up every review PR and compare branch for a closed same-repo parent', () => {
    assert.match(workflow, /^ {2}pull_request:\n {4}types: \[closed\]$/m)
    assert.doesNotMatch(workflow, /^ +pull_request_target:|uses: actions\/checkout/m)
    assert.match(
      workflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    )
    assert.match(workflow, /const prefix = `screenshots\/pr-\$\{parentNumber\}\/`/)
    assert.match(workflow, /const comparePrefix = `screenshot-compare\/pr-\$\{parentNumber\}\/`/)
    assert.match(workflow, /github\.rest\.git\.listMatchingRefs/)
  })
})

describe('cla.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/cla.yml'), 'utf8')
  const JOB_PERMISSIONS =
    /^ {4}permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}pull-requests: write\n {6}issues: write\n {6}statuses: write$/gm

  it('never checks out or runs pull request code, and holds just enough permission', () => {
    assert.match(workflow, /^ {2}pull_request_target:$/m)
    assert.match(workflow, /^permissions: \{\}$/m)
    // createComment on a pull request is refused with pull-requests: read.
    assert.equal(workflow.match(JOB_PERMISSIONS)?.length, 2, 'both jobs, and nothing broader')
    assert.doesNotMatch(workflow, /^ +run:/m, 'no shell step; the script only reads the API')
    assert.doesNotMatch(
      workflow,
      /github\.event\.pull_request\.head|github\.head_ref|refs\/pull\//,
      'under pull_request_target the head is attacker-controlled',
    )
    const checkouts = workflow.match(/uses: actions\/checkout@.*\n(?: {8}.*\n)+/g) ?? []
    assert.equal(checkouts.length, 2)
    const check = checkouts.at(0) ?? ''
    const backfill = checkouts.at(1) ?? ''
    // github.sha is the base branch tip under pull_request_target.
    assert.match(check, /^ {10}ref: \$\{\{ github\.sha \}\}$/m)
    // Under workflow_dispatch github.sha is the dispatched ref, which any
    // writer controls; the backfill always runs main's script.
    assert.match(backfill, /^ {10}ref: main$/m)
    for (const checkout of checkouts) {
      assert.match(checkout, /^ {10}persist-credentials: false$/m)
      assert.match(checkout, /^ {10}sparse-checkout: scripts\/cla-check\.mts$/m)
    }
  })

  it('refuses a backfill dispatched from any branch but main', () => {
    const job = workflow.slice(workflow.indexOf('\n  backfill:\n'))
    const refusal = job.indexOf("if (context.ref !== 'refs/heads/main') {")
    assert.ok(refusal > 0, 'the backfill checks the ref it was started from')
    assert.match(job.slice(refusal), /^ {14}core\.setFailed\(/m)
    assert.ok(
      refusal < job.indexOf('await import('),
      'the refusal comes before the script is loaded',
    )
  })

  it('shares one evaluation between the event path and the backfill', () => {
    assert.doesNotMatch(workflow, /createCommitStatus/, 'the rules live in scripts/cla-check.mts')
    assert.match(workflow, /const \{ evaluatePullRequest \} = await import\(/)
    assert.match(workflow, /const \{ evaluateOpenPullRequests \} = await import\(/)
    assert.equal(
      workflow.match(/`\$\{process\.env\.GITHUB_WORKSPACE\}\/scripts\/cla-check\.mts`/g)?.length,
      2,
    )
  })

  it('backfills heads no pull request event reached, and results an older rule computed', () => {
    // CLA is a required status. A head moved with the default GITHUB_TOKEN
    // raises no event, a pull request opened before the workflow existed never
    // had one, and a signature or rule change must reach every open head.
    const push = workflow.match(/^ {2}push:\n(?: {4}.*\n)+/m)?.[0] ?? ''
    assert.match(push, /^ {4}branches: \[main\]$/m)
    for (const path of [
      '.github/cla-signatures.json',
      '.github/workflows/cla.yml',
      'scripts/cla-check.mts',
    ]) {
      assert.ok(
        push.includes(`      - ${path}\n`),
        `a change to ${path} must re-evaluate every open head`,
      )
    }
    // A stacked pull request retargeted onto main carries whatever its old
    // base's workflow set; a cosmetic edit must not re-run the check.
    assert.match(workflow, /^ {4}types: \[[^\]]*\bedited\b[^\]]*\]$/m)
    assert.match(
      workflow,
      /github\.event\.action != 'edited' \|\| github\.event\.changes\.base != null/,
    )
    assert.match(workflow, /^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: '[^']+'$/m)
    assert.match(workflow, /^ {2}workflow_dispatch:$/m)
    assert.match(
      workflow,
      /github\.event_name == 'push' \|\| github\.event_name == 'schedule' \|\|\n\s+github\.event_name == 'workflow_dispatch'/,
    )
    assert.match(workflow, /ONLY_CHANGED: \$\{\{ github\.event_name == 'schedule' \}\}/)
    assert.match(workflow, /\{ onlyChanged: process\.env\.ONLY_CHANGED === 'true' \}/)
  })
})

describe('promote-develop.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/promote-develop.yml'), 'utf8')

  it('runs daily and only opens a PR when trunk has commits to promote', () => {
    assert.match(workflow, /- cron: '[^']+ \* \* \*'/)
    assert.match(workflow, /const base = 'release'/)
    assert.match(workflow, /const source = 'main'/)
    assert.match(workflow, /const head = 'promote\/main'/)

    const noChangesExit = workflow.indexOf('comparison.data.ahead_by === 0')
    const pin = workflow.indexOf('github.rest.git.createRef')
    const pullRequestLookup = workflow.indexOf('github.paginate')
    assert.match(workflow, /compare\/\{basehead\}/)
    assert.match(
      workflow,
      /basehead: `\$\{base\}\.\.\.\$\{sha\}`/,
      'compare the commit being pinned',
    )
    assert.ok(noChangesExit >= 0, 'expected an explicit no-unpromoted-commits exit')
    assert.ok(noChangesExit < pin, 'the no-changes exit must run before pinning promote/main')
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

  it('pins the promotion head by fast-forward only', () => {
    // A pinned head stops trunk merges cancelling the promotion's CI. It must
    // only ever hold `main` commits: forcing it could carry a commit pushed to
    // the branch by hand into `release`.
    assert.match(
      workflow,
      /updateRef\(\{ owner, repo, ref: `heads\/\$\{head\}`, sha, force: false \}\)/,
    )
    assert.doesNotMatch(workflow, /force: true/)
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

  it('validates notes for a new tag but not for an already-released version', () => {
    // Versions released before notes were kept per version have no section, so
    // an ordinary no-op promotion must not fail on them. A tag at this exact
    // commit is a recovery run and is validated like a new one.
    assert.match(
      workflow,
      /if \[ -z "\$existing" \] \|\| \[ "\$existing" = "\$RELEASE_SHA" \]; then\n\s+node scripts\/release-notes\.mts "\$version"/,
    )
  })
})

describe('release-bump.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/release-bump.yml'), 'utf8')

  it('runs weekly, ahead of the daily promotion', () => {
    assert.match(workflow, /^ {4}- cron: '37 5 \* \* 1'$/m)
    const promotion = readFileSync(resolve('.github/workflows/promote-develop.yml'), 'utf8')
    assert.match(
      promotion,
      /^ {4}- cron: '17 8 \* \* \*'$/m,
      'move the bump if the promotion moves',
    )
  })

  it('bumps main through a PR, never by pushing to main or release', () => {
    // The bump must pass the same `CI Passed` gate as any other change to main.
    assert.match(workflow, /peter-evans\/create-pull-request@/)
    assert.match(workflow, /^ {10}base: main$/m)
    assert.match(workflow, /^ {10}branch: chore\/release-bump$/m)
    assert.doesNotMatch(workflow, /git push/)
    assert.match(workflow, /gh pr merge "\$PR_NUMBER" --repo "\$GITHUB_REPOSITORY" --auto --squash/)
  })

  it('opens the PR as the release App so CI runs on it', () => {
    // A GITHUB_TOKEN PR triggers no workflows, so it could never go green.
    assert.match(workflow, /token: \$\{\{ steps\.app-token\.outputs\.token \}\}/)
    assert.match(workflow, /^ {2}contents: read$/m)
    assert.doesNotMatch(workflow, /^ {2}(contents|pull-requests): write$/m)
  })

  const publicationCheck = 'gh api "repos/$RELEASE_REPOSITORY/releases/tags/v$current"'

  it('keeps one release in flight and skips an empty week', () => {
    const published = workflow.indexOf(publicationCheck)
    const bump = workflow.indexOf('node scripts/release-bump.mts')
    assert.ok(published >= 0 && bump > published, 'the publication check must precede the bump')
    assert.match(workflow, /args=\(--skip-if-empty\)/)
  })

  it('cuts past an unpublished version only on an explicit dispatch, carrying its notes', () => {
    // A version whose release run failed can never be published, so a gate
    // with no way past it would stop the weekly train for good. The schedule
    // still skips; only a person naming the next version cuts past it, and the
    // abandoned version's notes move into the new section rather than vanish.
    const gate = workflow.slice(
      workflow.indexOf(publicationCheck),
      workflow.indexOf('node scripts/release-bump.mts'),
    )
    assert.match(gate, /if \[ -z "\$REQUESTED_VERSION" \]; then[\s\S]*?exit 0\n/)
    assert.match(gate, /args\+=\(--carry-forward\)/)
  })

  it('treats only a confirmed 404 as unpublished', () => {
    // A rate limit or outage read as "unpublished" would let a dispatch carry a
    // published version's notes into the next release a second time.
    const gate = workflow.slice(
      workflow.indexOf(publicationCheck),
      workflow.indexOf('if [ -z "$REQUESTED_VERSION" ]'),
    )
    assert.match(gate, /\*"HTTP 404"\*\) ;;\n\s+\*\)\n[\s\S]*?exit 1\n/)
    assert.match(gate, /gh api "repos\/\$RELEASE_REPOSITORY" --silent[\s\S]*?exit 1\n/)
    assert.doesNotMatch(workflow, /gh release view "v\$current"/)
  })

  it('passes the dispatch version through the environment, not the script text', () => {
    // An expression interpolated into `run:` is shell injection from the dispatch form.
    assert.match(workflow, /REQUESTED_VERSION: \$\{\{ inputs\.version \}\}/)
    assert.equal(workflow.split('${{ inputs.version }}').length - 1, 1)
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

  it('opens an issue when any release job fails', () => {
    // Without it a failed build is silent: nothing publishes and the weekly bump
    // skips while the version stays unpublished.
    const report = workflow.slice(workflow.indexOf('\n  report-failure:'))
    assert.match(
      report,
      /needs: \[preflight, verify-clean-release-build, build-test, assemble\]\n {4}if: failure\(\)/,
    )
    assert.match(report, /^ {6}issues: write$/m)
    assert.doesNotMatch(report, /contents: write/)
    assert.match(report, /gh issue create --repo "\$GITHUB_REPOSITORY"/)
    // The dispatch tag reaches the script through the environment only.
    assert.match(report, /TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/)
    assert.doesNotMatch(report.slice(report.indexOf('run: |')), /\$\{\{/)
  })

  it('signs, notarizes, and staples the DMG itself, then rebuilds its blockmap', () => {
    // electron-builder notarizes only the app inside the image. Stapling the
    // DMG rewrites it after electron-builder wrote its blockmap, so the map is
    // rebuilt from the final bytes before anything verifies or uploads it.
    assert.match(workflow, /electron-builder --mac .*-c\.dmg\.sign=true/)
    const start = workflow.indexOf('- name: Notarize and staple the DMG')
    const verify = workflow.indexOf('- name: Verify signatures, notarization, metadata')
    const upload = workflow.indexOf('uses: actions/upload-artifact@', verify)
    assert.ok(start > workflow.indexOf('-c.dmg.sign=true'), 'notarize after the signed build')
    assert.ok(verify > start && upload > verify, 'verify and upload the stapled DMG')
    const step = workflow.slice(start, verify)
    assert.match(step, /xcrun notarytool submit "\$dmg" .*\n.*--wait/)
    assert.match(step, /if \[ "\$status" != 'Accepted' \]; then[\s\S]*?exit 1\n/)
    const staple = step.indexOf('xcrun stapler staple "$dmg"')
    const rebuild = step.indexOf('node scripts/rebuild-dmg-blockmap.mts "$dmg"')
    assert.ok(staple > step.indexOf("!= 'Accepted'") && rebuild > staple)
    // Apple credentials reach the script through `env`, never the script text.
    assert.doesNotMatch(step.slice(step.indexOf('run: |')), /\$\{\{/)
  })

  it('verifies the downloadable DMG, not only the app inside it', () => {
    const verify = workflow.slice(
      workflow.indexOf('- name: Verify signatures, notarization, metadata'),
      workflow.indexOf('- name: Enforce the per-client size budget'),
    )
    assert.match(verify, /codesign --verify --strict --verbose=2 "\$dmg"/)
    assert.match(verify, /spctl -a -vvv -t open --context context:primary-signature "\$dmg"/)
    assert.match(verify, /xcrun stapler validate "\$dmg"/)
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
    assert.doesNotMatch(workflow, /electron-builder|build:release|pnpm install/)
  })

  it('tags each release on its own commit, so releases sort by publication', () => {
    // GitHub dates and orders releases by the tagged commit. Tagging the binary
    // repository's unchanging `main` dated every release to one commit, and a
    // new beta sorted below the old ones.
    assert.doesNotMatch(workflow, /--target main/)
    const record = workflow.indexOf('- name: Record the release in the release repository')
    const publish = workflow.indexOf('gh release create')
    assert.ok(record >= 0 && publish > record, 'the release commit must precede the release')
    const recordStep = workflow.slice(record, workflow.indexOf('- name: Publish the exact'))
    assert.match(recordStep, /--method PUT "repos\/\$RELEASE_REPOSITORY\/contents\/\$path"/)
    assert.match(recordStep, /-f branch=main/)
    assert.match(recordStep, /\*"HTTP 404"\*\) current='' ;;\n\s+\*\)\n[\s\S]*?exit 1\n/)
    assert.match(recordStep, /echo "commit=\$commit" >> "\$GITHUB_OUTPUT"/)
    assert.match(workflow, /RELEASE_COMMIT: \$\{\{ steps\.record\.outputs\.commit \}\}/)
    assert.match(workflow, /--repo "\$RELEASE_REPOSITORY" --target "\$RELEASE_COMMIT"/)
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

  it('scans main on a daily schedule on a runner that always resolves', () => {
    assert.doesNotMatch(workflow, /^ {2}pull_request:/m)
    // Per-push scanning produced a SARIF artifact nobody is notified of, ~30
    // times a day. The daily scan is the whole trigger surface now.
    assert.doesNotMatch(workflow, /^ {2}push:/m)
    assert.match(workflow, /^ {4}- cron: '\d+ \d+ \* \* \*'$/m)
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

describe('sync-model-catalog.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/sync-model-catalog.yml'), 'utf8')

  it('provisions the hosted Linux sandbox before full validation', () => {
    const provision = workflow.indexOf('Install sandbox dependencies for validation')
    const validate = workflow.indexOf('- name: Validate')
    assert.ok(provision >= 0 && validate > provision)
    assert.match(workflow, /apt-get install -y --no-install-recommends bubblewrap socat/)
    assert.match(workflow, /apparmor_restrict_unprivileged_userns=0/)
    assert.ok(workflow.includes('bwrap --unshare-all --dev-bind / / --die-with-parent true'))
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

describe('install-free scheduled repository script invariants', () => {
  const workflows = [
    '.github/workflows/acp-v2-watch.yml',
    '.github/workflows/prune-scaleway-ips.yml',
    '.github/workflows/prune-scaleway-volumes.yml',
  ].map((path) => readFileSync(resolve(path), 'utf8'))

  it('resolves the workspace leaf from source without restoring node_modules', () => {
    for (const workflow of workflows) {
      assert.ok(!workflow.includes('uses: ./.github/actions/setup'))
    }
    const watch = readFileSync(resolve('scripts/acp-v2-watch.mts'), 'utf8')
    const helper = readFileSync(resolve('scripts/lib/cloud-hosts.mts'), 'utf8')
    assert.ok(watch.includes('../packages/std/src/unknown-value.ts'))
    assert.ok(helper.includes('../../packages/std/src/unknown-value.ts'))
  })
})

describe('gitleaks workflow invariants', () => {
  const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
  const gitleaksWorkflow = readFileSync(resolve('.github/workflows/gitleaks.yml'), 'utf8')
  const trustedCheckEvent =
    "github.event_name == 'merge_group' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)"

  it('scans trusted PRs and queue groups in precheck and leaves fork scans on hosted runners', () => {
    const precheckJob = ciWorkflow.match(/^ {2}precheck:\n[\s\S]*?(?=^ {2}[a-zA-Z0-9_-]+:\n)/m)?.[0]
    assert.ok(precheckJob, 'expected a `precheck:` job in ci.yml')
    for (const name of ['Install pinned gitleaks CLI', 'Scan repository history for secrets']) {
      assert.ok(precheckJob.includes(`- name: ${name}\n        if: ${trustedCheckEvent}`))
    }
    assert.match(
      gitleaksWorkflow,
      /^ {4}if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name != github\.repository$/m,
    )
    assert.match(gitleaksWorkflow, /^ {4}runs-on: ubuntu-latest$/m)
  })
})

describe('Copse Reviewer workflow invariants', () => {
  const triggerWorkflow = readFileSync(resolve('.github/workflows/review-trigger.yml'), 'utf8')
  const reusableWorkflow = readFileSync(resolve('.github/workflows/reviewer.yml'), 'utf8')
  const findingsAction = readFileSync(resolve('.github/actions/review-findings/action.yml'), 'utf8')
  const summaryWorkflow = readFileSync(resolve('.github/workflows/review-summary.yml'), 'utf8')
  const nightlyWorkflow = readFileSync(resolve('.github/workflows/review-nightly.yml'), 'utf8')
  const modelBenchWorkflow = readFileSync(
    resolve('.github/workflows/review-model-bench.yml'),
    'utf8',
  )
  const reviewCellDockerfile = readFileSync(resolve('packages/review/Dockerfile.cell'), 'utf8')
  const groundCellScript = readFileSync(
    resolve('packages/review/ci/ground-as-cell-user.sh'),
    'utf8',
  )
  const forgeReview = readFileSync(resolve('packages/review/src/forge-review.ts'), 'utf8')

  function workflowJobBlock(workflow: string, name: string): string {
    const header = `  ${name}:\n`
    const start = workflow.indexOf(header)
    assert.ok(start >= 0, `expected a \`${name}:\` job`)
    const rest = workflow.slice(start + header.length)
    const next = rest.search(/^ {2}[a-z][a-z0-9_-]*:\n/m)
    return next >= 0 ? workflow.slice(start, start + header.length + next) : workflow.slice(start)
  }

  it('dogfoods the local reusable workflow after PR requests and supports manual dispatch', () => {
    assert.match(triggerWorkflow, /^ {2}workflow_dispatch:$/m)
    assert.match(triggerWorkflow, /^on:\n {2}workflow_run:$/m)
    assert.match(triggerWorkflow, /workflows: \[Copse review request\]/)
    assert.doesNotMatch(triggerWorkflow, /^ {2}(?:pull_request|pull_request_target|push):/m)
    assert.match(
      triggerWorkflow,
      /group: copse-review-trigger-\$\{\{ github\.event\.workflow_run\.pull_requests\[0\]\.number \|\| inputs\.pr/,
    )
    const review = workflowJobBlock(triggerWorkflow, 'review')
    assert.match(review, /uses: \.\/\.github\/workflows\/reviewer\.yml/)
    assert.match(review, /reviewer-ref: \$\{\{ github\.sha \}\}/)
    assert.match(review, /preparation: copse-pnpm/)
    assert.match(review, /github\.event_name == 'workflow_dispatch'/)
    assert.doesNotMatch(review, /runs-on:|steps:|actions: write/)
    assert.doesNotMatch(triggerWorkflow, /gh workflow run|^ {2}summary:/m)
  })

  it('signals PR requests without executing PR code or carrying credentials', () => {
    const signal = readFileSync(resolve('.github/workflows/copse-review-request.yml'), 'utf8')
    assert.match(signal, /^permissions: \{\}$/m)
    assert.match(signal, /types: \[opened, reopened, synchronize, ready_for_review\]/)
    assert.match(signal, /head\.repo\.id == github\.event\.repository\.id/)
    assert.doesNotMatch(
      signal,
      /\$\{\{\s*secrets\.|uses:|download-artifact|pull_request_target|edited|labeled/,
    )
  })

  it('retains the credential-free runner boundary for independent nightly sampling', () => {
    const groundJobs = [workflowJobBlock(nightlyWorkflow, 'ground')]
    for (const job of groundJobs) {
      assert.match(job, /permissions: \{\}/)
      assert.doesNotMatch(job, /\$\{\{\s*secrets\./)
      assert.match(job, /ref: \$\{\{ github\.(?:sha|event\.repository\.default_branch) \}\}/)
      assert.match(job, /persist-credentials: false/)
      assert.match(job, /bash packages\/review\/ci\/ground-as-cell-user\.sh/)
      assert.doesNotMatch(job, /--backend ephemeral-runner/, 'never as the runner user')
    }
    // Pull-request code runs as a user that can reach nothing a later step
    // executes with the job's Actions runtime token.
    assert.match(groundCellScript, /refs\/pull\/\$\{PR_NUMBER\}\/head/)
    assert.match(groundCellScript, /--backend ephemeral-runner/)
    assert.match(groundCellScript, /--scratch-parent "\$cell_home\/scratch"/)
    assert.match(groundCellScript, /sudo useradd [^\n]*"\$cell_user"/)
    assert.match(groundCellScript, /sudo chmod 0700 "\$HOME"/)
    assert.match(groundCellScript, /sudo -u "\$cell_user" -- env -i \\/)
    assert.match(groundCellScript, /sudo usermod --lock --expiredate 1 "\$cell_user"/)
    assert.match(groundCellScript, /sudo pkill -KILL -u "\$cell_user"/)
    const cli = groundCellScript.indexOf('--backend ephemeral-runner')
    assert.ok(groundCellScript.indexOf('sudo chmod 0700 "$HOME"') < cli)
    assert.ok(groundCellScript.lastIndexOf('as_cell ', cli) < cli, 'the CLI runs as the cell user')
    assert.ok(cli < groundCellScript.indexOf('sudo pkill'))
    assert.ok(
      groundCellScript.indexOf('sudo pkill') < groundCellScript.indexOf('> "$OUT_DIR/report.json"'),
    )

    for (const job of [workflowJobBlock(nightlyWorkflow, 'findings')]) {
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

  it('keeps complete ancestry in nightly review checkouts', () => {
    const checkouts = nightlyWorkflow.matchAll(
      /uses: actions\/checkout[^\n]*\n([\s\S]*?)(?=\n {6}-|$)/g,
    )
    let count = 0
    for (const [, step] of checkouts) {
      assert.match(step ?? '', /filter: blob:none/)
      assert.match(step ?? '', /fetch-depth: 0/)
      assert.match(step ?? '', /persist-credentials: false/)
      count++
    }
    assert.ok(count > 0)
  })

  it('supports a manual summary without executing pull-request code', () => {
    assert.match(summaryWorkflow, /^on:\n {2}workflow_dispatch:$/m)
    assert.doesNotMatch(
      summaryWorkflow,
      /^ {2}(?:pull_request|pull_request_target|workflow_run|push):/m,
    )
    assert.match(
      summaryWorkflow,
      /^permissions:\n {2}contents: read\n {2}pull-requests: read$/m,
      'the default workflow token must not retain write permission',
    )
    assert.match(summaryWorkflow, /^ {2}group: copse-review-summary-\$\{\{ inputs\.pr \}\}$/m)
    const authorize = workflowJobBlock(summaryWorkflow, 'authorize')
    assert.match(authorize, /labels\.includes\('copse-review-skip'\)/)
    assert.match(authorize, /pull\.draft && !labels\.includes\('copse-review'\)/)
    assert.match(authorize, /pull\.head\.sha !== process\.env\.EXPECTED_HEAD/)
    const job = workflowJobBlock(summaryWorkflow, 'summary')
    assert.match(job, /^ {4}needs: authorize$/m)
    assert.match(job, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
    assert.match(job, /filter: blob:none/)
    assert.match(job, /persist-credentials: false/)
    // Read-only by construction: no Stage 0, no cell, no review.
    assert.match(job, /--summary-only/)
    assert.match(job, /--post-summary github/)
    assert.doesNotMatch(job, /--stage0-json|--backend|--post-review|--trusted-prepare|pnpm fetch/)
    assert.doesNotMatch(job, /docker|download-artifact/)
    assert.match(job, /test "\$author_id" = 338988/)
    assert.match(job, /test "\$skipped" = false/)
    assert.match(job, /test "\$draft" = false \|\| test "\$labelled" = true/)
    // The description is edited with the job's own workflow token: GitHub
    // starts no run for an event that token causes, so the `edited` event does
    // not re-run the whole of ci.yml on the same head, as an App-token edit did.
    assert.match(
      job,
      /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: write$/m,
      'only the summary job may write, and only pull requests',
    )
    assert.doesNotMatch(job, /create-github-app-token|RELEASE_APP_/)
    const posting = job.slice(job.indexOf('- name: Summarise the pull request and update'))
    assert.match(posting, /COPSE_REVIEW_FORGE_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
    assert.doesNotMatch(posting, /^\s+GITHUB_TOKEN:/m)
    const fetch = job.indexOf('git fetch')
    assert.ok(fetch >= 0 && fetch < job.indexOf('- name: Summarise the pull request and update'))
    // The full review rewrites the summary with its evidence.
    assert.match(findingsAction, /--post-summary github/)
  })

  it('posts GitHub reviews as the least-privilege Copse App identity', () => {
    const nightlyFindings = workflowJobBlock(nightlyWorkflow, 'findings')
    assert.match(
      nightlyFindings,
      /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read$/m,
    )

    for (const job of [nightlyFindings]) {
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
      // Reads driven by the pull request's text use the read-only workflow
      // token; the App's write token is for the post alone.
      assert.match(
        postingStep,
        /^ {10}COPSE_REVIEW_READ_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m,
      )
      assert.doesNotMatch(
        postingStep,
        /^\s+GITHUB_TOKEN:/m,
        'the posting step must not silently fall back to the workflow identity',
      )
    }
  })

  it('primes the isolated checks from data-only files at the exact pull-request head', () => {
    for (const workflow of [nightlyWorkflow]) {
      assert.match(workflowJobBlock(workflow, 'ground'), /ground-as-cell-user\.sh/)
    }
    {
      const job = groundCellScript
      assert.match(job, /git -C "\$GITHUB_WORKSPACE" show "\$\{HEAD_SHA\}:pnpm-lock\.yaml"/)
      assert.match(job, /git -C "\$GITHUB_WORKSPACE" archive --format=tar "\$HEAD_SHA" patches/)
      assert.match(
        job,
        /pnpm fetch --frozen-lockfile --dir "\$dependency_seed" --store-dir "\$store"/,
      )
      assert.doesNotMatch(job, /pnpm fetch[^\n]*--dir [^"$]/)
      const fetch = job.indexOf('pnpm fetch --frozen-lockfile')
      assert.ok(job.indexOf('rev-parse "refs/remotes/pr/') < fetch)
      assert.ok(fetch < job.indexOf('--backend ephemeral-runner'))
      assert.match(job, /--store "\$store"/)
      assert.match(job, /--trusted-prepare "\$trusted\/scripts\/prepare-review-stage0\.mts"/)
    }

    for (const workflow of [nightlyWorkflow]) {
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
    for (const workflow of [nightlyWorkflow]) {
      const job = workflowJobBlock(workflow, 'ground')
      assert.match(job, /apt-get install -y --no-install-recommends bubblewrap cargo ripgrep socat/)
      assert.match(job, /apparmor_restrict_unprivileged_userns=0/)
      assert.match(job, /bwrap --unshare-all --dev-bind \/ \/ --die-with-parent true/)
      assert.match(job, /export PATH="\$\{setup_node_bin\}:\/usr\/bin:\$\{PATH\}"/)
      assert.match(job, /test "\$\(command -v cargo\)" = \/usr\/bin\/cargo/)
      assert.match(job, /test "\$\(command -v node\)" = "\$\{setup_node_bin\}\/node"/)
      assert.ok(job.indexOf('apt-get install') < job.indexOf('ground-as-cell-user.sh'))
      assert.ok(job.indexOf('export PATH=') < job.indexOf('ground-as-cell-user.sh'))
    }
  })

  it('retains the bounded configured Scaleway profile in model-backed reviewer workflows', () => {
    for (const workflow of [nightlyWorkflow, modelBenchWorkflow]) {
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
    for (const workflow of [nightlyWorkflow]) {
      // The visual lens runs only when the change or its conversation has an image.
      assert.ok(workflow.includes("COPSE_REVIEW_LENSES || 'correctness,visual'"))
      // Reviews read the pull request's discussion and images, e.g. screenshot comments.
      assert.match(workflow, /--read-pr github \\\n\s+--repo "\$GITHUB_REPOSITORY"/)
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
    for (const workflow of [nightlyWorkflow]) {
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
      if (
        ![
          'review-model-bench.yml',
          'reviewer.yml',
          'review-nightly.yml',
          'review-summary.yml',
        ].includes(name)
      ) {
        assert.ok(!workflow.includes(secret), name)
      }
    }
    assert.equal(modelBenchWorkflow.split(secret).length - 1, 1)
    const install = modelBenchWorkflow.indexOf('- name: Install the reviewer')
    const model = modelBenchWorkflow.indexOf('- name: Run the advisory real-model benchmark')
    const credential = modelBenchWorkflow.indexOf(secret)
    const upload = modelBenchWorkflow.indexOf('- uses: actions/upload-artifact')
    assert.ok(install < model && model < credential && credential < upload)
    for (const workflow of [nightlyWorkflow]) {
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
    const copse = workflowJobBlock(reusableWorkflow, 'copse-findings')
    assert.match(copse, /^ {4}environment: copse-review-models$/m)
    assert.match(copse, /^ {6}pull-requests: read$/m)
    assert.match(copse, /github\.triggering_actor == 'jonathanKingston'/)
    assert.equal(reusableWorkflow.split(secret).length - 1, 1)
    assert.doesNotMatch(workflowJobBlock(reusableWorkflow, 'ground'), /secrets\./)
    const summary = workflowJobBlock(summaryWorkflow, 'summary')
    assert.equal(summaryWorkflow.split(secret).length - 1, 1)
    assert.match(summary, /^ {4}environment: copse-review-models$/m)
    assert.ok(
      summary.indexOf('- name: Summarise the pull request and update its description') <
        summary.indexOf(secret),
    )
    assert.match(summary, /unset COPSE_REVIEW_API_KEY SCW_DEFAULT_PROJECT_ID/)
    assert.match(summary, /configured\) unset OPENROUTER_API_KEY/)
  })

  it('samples at most one recent same-repository draft PR and has an explicit opt-out', () => {
    assert.match(nightlyWorkflow, /^ {2}schedule:$/m)
    assert.match(nightlyWorkflow, /^ {2}workflow_dispatch:$/m)
    assert.match(nightlyWorkflow, /pull\.head\.repo\?\.full_name === `\$\{owner\}\/\$\{repo\}`/)
    assert.match(nightlyWorkflow, /14 \* 24 \* 60 \* 60 \* 1000/)
    assert.match(nightlyWorkflow, /!labels\.includes\('copse-review'\)/)
    assert.match(nightlyWorkflow, /!labels\.includes\('copse-review-skip'\)/)
    assert.match(nightlyWorkflow, /selected = candidates\[utcDay % candidates\.length\]/)
    // Ready pull requests are reviewed on becoming ready; the sample covers drafts.
    assert.match(nightlyWorkflow, /pull\.draft === true/)
    assert.doesNotMatch(nightlyWorkflow, /selected\.draft/, 'a dispatched PR may be either')
    assert.doesNotMatch(nightlyWorkflow, /^ {2}pull_request:/m)
  })

  it('keeps reviews advisory and retains machine-readable dogfood evidence', () => {
    assert.match(forgeReview, /event: 'COMMENT'/)
    assert.doesNotMatch(forgeReview, /REQUEST_CHANGES/)
    for (const workflow of [nightlyWorkflow]) {
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
