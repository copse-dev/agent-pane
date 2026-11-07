import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'

const steps = z
  .object({
    jobs: z.object({
      precheck: z.object({
        steps: z.array(
          z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            run: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
          }),
        ),
      }),
    }),
  })
  .parse(load(readFileSync('.github/workflows/ci.yml', 'utf8'))).jobs.precheck.steps
const plan = steps.find((step) => step.id === 'plan') ?? assert.fail('missing real CI plan')
const checkpoint =
  steps.find((step) => step.name?.startsWith('Screenshot evidence plan:')) ??
  assert.fail('missing screenshot evidence checkpoint')
const producers = z
  .object({
    jobs: z.record(
      z.string(),
      z.object({
        steps: z.array(
          z.object({
            name: z.string().optional(),
            run: z.string().optional(),
            uses: z.string().optional(),
            if: z.string().optional(),
            'continue-on-error': z.boolean().optional(),
            env: z.record(z.string(), z.string()).optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    ),
  })
  .parse(load(readFileSync('.github/workflows/ci.yml', 'utf8'))).jobs

// Stub only process boundaries: execute CI's real shell, including its early
// exits, while the existing oracle tests own diff-to-spec selection itself.
function selectedPlan(changed: string, oracleMode: string, draft: boolean): Map<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'screenshot-plan-'))
  try {
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\nif [ "$1" = diff ]; then printf "%s\\n" "$FIXTURE_CHANGED"; fi\n',
      { mode: 0o755 },
    )
    writeFileSync(
      join(bin, 'node'),
      '#!/bin/sh\ntest "$1" = scripts/test-oracle.mts || exit 1\nprintf "%s\\n" "$FIXTURE_ORACLE"\n',
      { mode: 0o755 },
    )
    const output = join(directory, 'outputs')
    const result = spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', plan.run ?? 'exit 1'], {
      encoding: 'utf8',
      cwd: directory,
      timeout: 5_000,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
        RUNNER_TEMP: directory,
        EVENT: 'pull_request',
        REF: 'refs/pull/123/merge',
        BASE_REF: 'main',
        BASE_SHA: 'a'.repeat(40),
        HEAD_SHA: 'b'.repeat(40),
        PR_DRAFT: String(draft),
        STACK_TIP: 'false',
        CI_FULL_LABEL: 'false',
        UPDATE_SCREENSHOTS_LABEL: 'false',
        SCREENSHOT_REFRESH: 'false',
        FIXTURE_CHANGED: changed,
        FIXTURE_ORACLE: `mode=${oracleMode}\nspecs=\nunit_mode=full`,
      },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    return new Map(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=')
          return [line.slice(0, separator), line.slice(separator + 1)]
        }),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('CI screenshot evidence provenance', () => {
  it('names the actual render and transport steps the trusted metadata gate requires without changing their conditions', () => {
    const build = producers['build']?.steps ?? assert.fail('missing build')
    const e2e = producers['e2e']?.steps ?? assert.fail('missing e2e')
    for (const [name, run] of [
      ['Build browser reference app', 'npm run build:demo'],
      [
        'Render browser reference screenshots',
        'npm run test:demo -- --exclude tests/demo/streamed-reply-motion.demo.ts',
      ],
      [
        'Render isolated browser motion screenshots',
        'npm run test:demo -- --spec tests/demo/streamed-reply-motion.demo.ts --maxInstances 1',
      ],
    ]) {
      const matching = build.filter((step) => step.name === name)
      assert.equal(matching.length, 1)
      assert.equal(matching[0]?.run, run)
      assert.equal(matching[0]?.if, "needs.precheck.outputs.mode != 'skip'")
    }
    for (const [steps, name, artifact] of [
      [build, 'Upload rendered browser screenshots', 'screenshots-demo'],
      [e2e, 'Upload rendered screenshot shard', 'screenshots-shard-${{ matrix.shard }}'],
    ] satisfies [typeof build, string, string][]) {
      const matching = steps.filter((step) => step.name === name)
      assert.equal(matching.length, 1)
      const producer = matching[0]
      assert.ok(producer)
      const upload = producer.with ?? assert.fail('missing producer upload configuration')
      assert.equal(producer.uses, 'actions/upload-artifact@v7')
      assert.equal(upload['name'], artifact)
      // These dedicated producer directories contain the hidden sentinels even
      // when there are no changed PNGs. Uploading PNG globs alone loses proof.
      assert.equal(upload['path'], 'changed/')
      assert.equal(upload['include-hidden-files'], true)
      assert.equal(upload['if-no-files-found'], 'error')
      assert.match(producer.if ?? '', /success\(\).*github.event_name == 'pull_request'/)
    }
    assert.match(
      build.find((step) => step.name === 'Collect changed browser reference screenshots')?.run ??
        '',
      /touch changed\/\.demo/,
    )
    assert.match(
      e2e.find((step) => step.name === 'Collect changed reference screenshots')?.run ?? '',
      /> "changed\/\.shard-\$\{\{ matrix.shard \}\}"/,
    )
    const immutableUploads =
      producers['screenshot-artifacts']?.steps.filter(
        (step) => step.name === 'Upload immutable screenshot candidates',
      ) ?? []
    assert.equal(immutableUploads.length, 1)
    const immutableUpload = immutableUploads[0]
    assert.ok(immutableUpload)
    assert.equal(immutableUpload.if, "steps.candidates.outputs.count != '0'")
    assert.equal(
      immutableUpload.with?.['name'],
      'reference-screenshot-candidates-${{ github.run_id }}',
    )
  })

  it('verifies all downloaded producer sentinels before interpreting full, subset or zero-image collections', () => {
    const collector = producers['screenshot-artifacts']?.steps ?? assert.fail('missing collector')
    const name = 'Verify complete screenshot producer inputs'
    const matching = collector.filter((step) => step.name === name)
    assert.equal(matching.length, 1, 'missing collector input checkpoint')
    const inputs = matching[0] ?? assert.fail('missing collector input checkpoint')
    assert.deepEqual(inputs.env, {
      SHARD_TOTAL: '${{ needs.precheck.outputs.e2e_shard_total }}',
    })
    assert.equal(inputs.if, undefined)
    assert.notEqual(inputs['continue-on-error'], true)
    const index = collector.indexOf(inputs)
    assert.equal(collector[index - 1]?.name, 'Download rendered screenshot candidates')
    assert.equal(collector[index + 1]?.name, 'Drop render noise from the candidate set')
    const directory = mkdtempSync(join(tmpdir(), 'screenshot-inputs-'))
    try {
      const cases: [string, string[], boolean, boolean][] = [
        ['9', [], false, true],
        ['9', [], true, true],
        ['1', [], false, true],
        ['3', [], true, true],
        ['9', ['.shard-9'], false, false],
        ['3', ['.shard-2'], true, false],
        ['1', ['.shard-1'], false, false],
        ['1', ['.demo'], true, false],
        ['1', ['.shard-1', '.demo'], false, false],
        ['0', [], false, false],
        ['10', [], false, false],
        ['', [], false, false],
      ]
      for (const [total, missing, images, success] of cases) {
        const candidates = join(directory, 'candidates')
        rmSync(candidates, { recursive: true, force: true })
        mkdirSync(join(candidates, 'tests/e2e/screenshots'), { recursive: true })
        for (const marker of [
          '.demo',
          ...Array.from({ length: Number(total) }, (_, i) => `.shard-${String(i + 1)}`),
        ]) {
          if (!missing.includes(marker))
            writeFileSync(join(candidates, marker), images ? 'advisory only' : '')
        }
        if (images) writeFileSync(join(candidates, 'tests/e2e/screenshots/example.png'), 'PNG')
        const result = spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', inputs.run ?? 'exit 1'], {
          encoding: 'utf8',
          cwd: directory,
          timeout: 5_000,
          env: { SHARD_TOTAL: total },
        })
        assert.equal(result.error, undefined)
        assert.equal(
          result.status === 0,
          success,
          `${total}/${missing.join(',')}/${String(images)}`,
        )
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('does not relabel a visible draft plan as no-eligible when draft policy skips its jobs', () => {
    for (const draft of [true, false]) {
      const output = selectedPlan('src/renderer/views/thread.ts', 'full', draft)
      assert.equal(output.get('mode'), 'full')
      assert.equal(output.get('screenshot_scope'), 'render')
    }
  })

  it('marks only the oracle no-eligible path, including README-only and non-visual backend changes', () => {
    for (const changed of ['README.md', 'docs/example.md', 'src/main/services/calculation.ts']) {
      const output = selectedPlan(changed, 'skip', false)
      assert.equal(output.get('mode'), 'skip')
      assert.equal(output.get('screenshot_scope'), 'no-eligible')
    }
  })

  it('distinguishes reference-only followups from proven no-eligible coverage', () => {
    const output = selectedPlan('tests/e2e/screenshots/manifest.json\nREADME.md', 'full', false)
    assert.equal(output.get('mode'), 'skip')
    assert.equal(output.get('screenshot_scope'), 'reference-followup')
  })

  it('binds the checkpoint to real plan/shard outputs and rejects ambiguous or suppressed skip shapes', () => {
    assert.deepEqual(checkpoint.env, {
      SCOPE: '${{ steps.plan.outputs.screenshot_scope }}',
      MODE: '${{ steps.plan.outputs.mode }}',
      SHARDS: '${{ steps.shards.outputs.total }}',
    })
    assert.match(checkpoint.name ?? '', /steps.plan.outputs.screenshot_scope/)
    assert.match(checkpoint.name ?? '', /steps.shards.outputs.total/)
    for (const [scope, mode, shards, success] of [
      ['render', 'full', '9', true],
      ['render', 'subset', '1', true],
      ['render', 'subset', '9', true],
      ['no-eligible', 'skip', '0', true],
      ['reference-followup', 'skip', '0', true],
      ['render', 'skip', '0', false],
      ['draft', 'skip', '0', false],
      ['cosmetic', 'skip', '0', false],
      ['render', 'full', '0', false],
      ['render', 'subset', '0', false],
      ['no-eligible', 'full', '0', false],
      ['', '', '', false],
    ] satisfies [string, string, string, boolean][]) {
      const result = spawnSync('bash', ['-eu', '-c', checkpoint.run ?? 'exit 1'], {
        encoding: 'utf8',
        timeout: 5_000,
        env: { SCOPE: scope, MODE: mode, SHARDS: shards },
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status === 0, success, `${scope}/${mode}/${shards}`)
    }
  })
})
