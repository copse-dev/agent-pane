import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const sha = 'a'.repeat(40)
const repo = 'copse-dev/agent-pane'
const run = {
  id: 42,
  run_number: 12,
  run_attempt: 1,
  path: '.github/workflows/ci.yml',
  event: 'push',
  head_sha: sha,
  repository: { full_name: repo },
  head_repository: { full_name: repo },
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/copse-dev/agent-pane/actions/runs/42',
}
const gate = {
  id: 99,
  name: 'Full release validation',
  status: 'completed',
  conclusion: 'success',
  head_sha: sha,
  completed_at: '2026-10-16T12:00:00Z',
}

function verify(
  options: {
    run?: Partial<typeof run>
    jobs?: (typeof gate)[]
    missing?: boolean
    apiFailure?: boolean
    pinned?: string
  } = {},
): SpawnSyncReturns<string> {
  const dir = mkdtempSync(join(tmpdir(), 'release-validation-'))
  try {
    const current = { ...run, ...options.run }
    writeFileSync(join(dir, 'run.json'), JSON.stringify(current))
    writeFileSync(
      join(dir, 'runs.json'),
      JSON.stringify({ workflow_runs: options.missing ? [] : [current] }),
    )
    // Gate on the second page catches accidental loss of pagination.
    writeFileSync(
      join(dir, 'jobs.json'),
      JSON.stringify([{ jobs: [] }, { jobs: options.jobs ?? [gate] }]),
    )
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env bash
set -eu
[ "$API_FAILURE" = false ] || exit 1
case "$*" in
  *workflows/ci.yml/runs*) cat "$FIXTURES/runs.json" ;;
  *attempts/*/jobs*) [[ "$*" == *--paginate* && "$*" == *--slurp* ]] || exit 1; cat "$FIXTURES/jobs.json" ;;
  *actions/runs/42) cat "$FIXTURES/run.json" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    )
    return spawnSync(
      'bash',
      ['scripts/verify-release-validation.sh', sha, ...(options.pinned ? [options.pinned] : [])],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          FIXTURES: dir,
          GITHUB_REPOSITORY: repo,
          API_FAILURE: String(options.apiFailure ?? false),
        },
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('release evidence verification', () => {
  it('records exact-SHA successful full CI with paginated jobs', () => {
    const result = verify()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"ci_run_id": 42/)
    assert.match(result.stdout, /"e2e_mode": "full"/)
    assert.match(result.stdout, new RegExp(sha))
    assert.equal(verify({ pinned: '42' }).stdout, result.stdout)
  })
  it('waits only for missing or in-progress evidence', () => {
    assert.equal(verify({ missing: true }).status, 75)
    assert.equal(verify({ run: { status: 'in_progress' }, jobs: [] }).status, 75)
    assert.equal(verify({ jobs: [{ ...gate, status: 'in_progress', conclusion: '' }] }).status, 75)
  })
  for (const conclusion of ['failure', 'skipped', 'cancelled', 'neutral', 'timed_out']) {
    it(`rejects a ${conclusion} gate and workflow`, () => {
      assert.equal(verify({ jobs: [{ ...gate, conclusion }] }).status, 1)
      assert.equal(verify({ run: { conclusion } }).status, 1)
    })
  }
  it('rejects absent or ambiguous gates and API failures', () => {
    for (const options of [
      { jobs: [] },
      { jobs: [gate, gate] },
      { apiFailure: true },
      { pinned: 'garbage' },
    ]) {
      assert.equal(verify(options).status, 1)
    }
  })
  it('rejects wrong workflow, event, repository or SHA', () => {
    for (const override of [
      { path: '.github/workflows/fake.yml' },
      { event: 'pull_request' },
      { head_sha: 'b'.repeat(40) },
      { repository: { full_name: 'other/repo' } },
      { head_repository: { full_name: 'fork/repo' } },
    ]) {
      assert.equal(verify({ run: override }).status, 1)
    }
    assert.equal(verify({ jobs: [{ ...gate, head_sha: 'b'.repeat(40) }] }).status, 1)
  })
  it('changes the evidence on rerun, so publishing cannot silently substitute attempts', () => {
    assert.notEqual(verify({ run: { run_attempt: 2 } }).stdout, verify().stdout)
  })
})

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
function shellBetween(start: string, end: string): string {
  const a = workflow.indexOf(start)
  const b = workflow.indexOf(end, a)
  assert.ok(a >= 0 && b > a)
  return workflow
    .slice(a, b)
    .replace(/^ {10}/gm, '')
    .replaceAll('>> "$GITHUB_OUTPUT"', '>&1')
}

describe('release full-suite contract', () => {
  it('forces release and v-tag pushes to full even for screenshot-only changes', () => {
    const shell = shellBetween(
      '          BASE_REF="${BASE_REF#refs/heads/}"',
      '          # A stack tip covers',
    )
    for (const ref of ['refs/heads/release', 'refs/tags/v1.2.3']) {
      const result = spawnSync('bash', ['-eu', '-c', shell], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EVENT: 'push',
          REF: ref,
          BASE_REF: '',
          HEAD_SHA: sha,
          GITHUB_OUTPUT: '/dev/stdout',
        },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /mode=full\nspecs=\nunit_mode=full/)
    }
    const main = spawnSync('bash', ['-eu', '-c', shell], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT: 'push',
        REF: 'refs/heads/main',
        BASE_REF: '',
        GITHUB_OUTPUT: '/dev/stdout',
      },
    })
    assert.equal(main.stdout, '')
  })
  it('rejects every incomplete plan and prerequisite in the real aggregate shell', () => {
    const block = workflow.slice(workflow.indexOf('  full-release-validation:'))
    assert.match(block, /if: \$\{\{ cancelled\(\) \}\}\n +run: exit 1/)
    assert.doesNotMatch(block, /CANCELLED: \$\{\{ cancelled\(\)/)
    const shell = block.slice(block.indexOf('          set -euo pipefail')).replace(/^ {10}/gm, '')
    const results = Object.fromEntries(
      ['precheck', 'screenshot-baselines', 'check', 'bench', 'build', 'e2e', 'ci-passed'].map(
        (name) => [name, { result: 'success' }],
      ),
    )
    const env = {
      ...process.env,
      CANCELLED: 'false',
      MODE: 'full',
      UNIT_MODE: 'full',
      SHARDS: '8',
      RESULTS: JSON.stringify(results),
    }
    const execute = (overrides: Record<string, string>): number | null =>
      spawnSync('bash', ['-c', shell], { encoding: 'utf8', env: { ...env, ...overrides } }).status
    assert.equal(execute({}), 0)
    for (const overrides of [
      { MODE: 'subset' },
      { MODE: 'skip' },
      { UNIT_MODE: 'subset' },
      { SHARDS: '7' },
    ])
      assert.notEqual(execute(overrides), 0)
    for (const name of Object.keys(results)) {
      for (const result of ['skipped', 'failure', 'cancelled'])
        assert.notEqual(execute({ RESULTS: JSON.stringify({ ...results, [name]: { result } }) }), 0)
    }
  })
})

describe('release evidence workflow wiring', () => {
  const packaging = readFileSync('.github/workflows/release-mac.yml', 'utf8')
  const publishing = readFileSync('.github/workflows/release-publish.yml', 'utf8')
  it('keeps verification before any public repository write', () => {
    assert.ok(
      publishing.indexOf('bash scripts/verify-release-validation.sh') <
        publishing.indexOf('- name: Record the release'),
    )
    assert.match(publishing, /diff -u .*release\/RELEASE_VALIDATION\.json/)
    assert.match(publishing, /gh release create[^\n]*release\/RELEASE_VALIDATION\.json/)
  })
  it('carries the packaging evidence through checksums and metadata', () => {
    assert.match(
      packaging,
      /bash scripts\/verify-release-validation\.sh "\$release_sha" > release-validation\.json/,
    )
    assert.match(packaging, /sha256sum RELEASE_VALIDATION\.json >> SHA256SUMS/)
    assert.match(packaging, /release\/RELEASE_NOTES\.md\n +release\/RELEASE_VALIDATION\.json/)
    assert.doesNotMatch(packaging, /check_name=CI%20Passed/)
  })
})
