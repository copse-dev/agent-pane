import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, describe, it } from 'node:test'
import {
  TERMINAL_BENCH_DATASET_DESCRIPTOR,
  terminalBenchTaskMetadata,
} from './lib/terminal-bench-tasks.mts'
import { terminalBenchProfile } from './lib/terminal-bench-profiles.mts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fixture(contents = 'safe trace data'): string {
  const root = mkdtempSync(join(tmpdir(), 'copse-terminal-seal-'))
  roots.push(root)
  const trial = join(root, 'bench-results', 'terminal-bench', 'job', 'trial')
  mkdirSync(join(trial, 'agent'), { recursive: true })
  writeFileSync(
    join(trial, 'result.json'),
    JSON.stringify({
      task_name: 'debug-task',
      started_at: '2026-07-21T10:00:00Z',
      finished_at: '2026-07-21T10:01:00Z',
      exception_info: null,
      verifier_result: { rewards: { reward: 0 } },
      agent_result: {
        n_input_tokens: 100,
        n_output_tokens: 20,
        metadata: {
          profile: 'main-legacy@1',
          profile_hash: terminalBenchProfile('main-legacy').contentHash,
          tool_calls: 4,
          model_requests: 2,
          command_timeouts: 0,
        },
      },
    }),
  )
  const task = terminalBenchTaskMetadata('cancel-async-tasks')
  const resultPath = join(trial, 'result.json')
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
  result['task_name'] = task.name
  writeFileSync(resultPath, JSON.stringify(result))
  writeFileSync(
    join(trial, 'task-image.json'),
    JSON.stringify({
      schemaVersion: 2,
      datasetId: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId,
      datasetVersion: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetVersion,
      datasetRevision: TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision,
      taskConfigSha256: task.configSha256,
      reference: task.image,
      imageId: `sha256:${'a'.repeat(64)}`,
      repoDigests: [`${task.image.slice(0, task.image.lastIndexOf(':'))}@sha256:${'b'.repeat(64)}`],
    }),
  )
  writeFileSync(join(trial, 'agent', 'copse-trace.jsonl'), contents)
  return root
}

function runSeal(root: string, extraEnv: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [resolve('scripts/seal-terminal-bench.mts')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, COPSE_BENCH_RUN_ID: 'test-run', ...extraEnv },
  })
}

describe('terminal benchmark capsule sealing', () => {
  it('writes a per-trial archive and a digest-bearing suite index', () => {
    const root = fixture()
    const sealed = runSeal(root, {
      COPSE_TERMINAL_INSTANCE_TYPE: 'PRO2-S',
      COPSE_TERMINAL_INSTANCE_COUNT: '1',
      COPSE_TERMINAL_WORKERS_PER_INSTANCE: '2',
      COPSE_TERMINAL_VOLUME_SIZE_GB: '200',
      COPSE_TERMINAL_SHARD_COUNT: '2',
      COPSE_TERMINAL_SHARD_INDEX: '1',
    })
    assert.equal(sealed.status, 0, String(sealed.stderr))

    const capsules = join(root, 'bench-results', 'terminal-bench-capsules')
    const index: unknown = JSON.parse(readFileSync(join(capsules, 'index.json'), 'utf8'))
    assert.equal(typeof index, 'object')
    const entries =
      typeof index === 'object' && index !== null
        ? (index as Record<string, unknown>)['capsules']
        : undefined
    assert.ok(Array.isArray(entries))
    assert.equal(entries.length, 1)
    const entry = (entries as unknown[])[0]
    assert.equal(typeof entry, 'object')
    const archive =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['archive']
        : undefined
    const digest =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['sha256']
        : undefined
    const outcome =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['outcome']
        : undefined
    assert.equal(typeof archive, 'string')
    assert.match(String(digest), /^[a-f0-9]{64}$/)
    assert.equal(outcome, 'zero')
    assert.equal((entry as Record<string, unknown>)['profile'], 'main-legacy@1')
    assert.ok(readFileSync(join(capsules, String(archive))).length > 0)

    const trialManifest: unknown = JSON.parse(
      readFileSync(
        join(root, 'bench-results', 'terminal-bench', 'job', 'trial', 'run-manifest.json'),
        'utf8',
      ),
    )
    assert.equal((trialManifest as Record<string, unknown>)['schemaVersion'], 2)
    const dataset = (trialManifest as Record<string, unknown>)['dataset'] as Record<string, unknown>
    const profile = (trialManifest as Record<string, unknown>)['profile'] as Record<string, unknown>
    const metrics = (trialManifest as Record<string, unknown>)['metrics'] as Record<string, unknown>
    const infrastructure = (trialManifest as Record<string, unknown>)['infrastructure'] as Record<
      string,
      unknown
    >
    assert.equal(dataset['revision'], TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision)
    assert.equal(
      dataset['taskConfigSha256'],
      terminalBenchTaskMetadata('cancel-async-tasks').configSha256,
    )
    assert.match(String(dataset['imageDigest']), /^sha256:[a-f0-9]{64}$/)
    assert.match(String(profile['contentHash']), /^[a-f0-9]{64}$/)
    assert.equal(metrics['elapsedSeconds'], 60)
    assert.equal(metrics['toolCalls'], 4)
    assert.deepEqual(infrastructure, {
      instanceType: 'PRO2-S',
      instanceCount: 1,
      workersPerInstance: 2,
      volumeSizeGb: 200,
      shardCount: 2,
      shardIndex: 1,
    })
  })

  it('reuses an unchanged capsule on later checkpoints', () => {
    const root = fixture()
    const first = runSeal(root)
    assert.equal(first.status, 0, String(first.stderr))
    const capsules = join(root, 'bench-results', 'terminal-bench-capsules')
    const firstIndex = JSON.parse(readFileSync(join(capsules, 'index.json'), 'utf8')) as {
      capsules: Array<{ archive: string; sha256: string }>
    }
    const archive = firstIndex.capsules[0]
    assert.ok(archive)

    const second = runSeal(root)
    assert.equal(second.status, 0, String(second.stderr))
    assert.match(String(second.stdout), new RegExp(`bench:terminal:seal reused ${archive.archive}`))
    assert.doesNotMatch(String(second.stdout), /bench:terminal:seal bench-results\//)
    const secondIndex = JSON.parse(readFileSync(join(capsules, 'index.json'), 'utf8')) as {
      capsules: Array<{ archive: string; sha256: string }>
    }
    assert.deepEqual(secondIndex.capsules, firstIndex.capsules)
  })

  it('lists only capsules without a matching local upload receipt', () => {
    const root = fixture()
    const sealed = runSeal(root)
    assert.equal(sealed.status, 0, String(sealed.stderr))
    const capsules = join(root, 'bench-results', 'terminal-bench-capsules')
    const indexPath = join(capsules, 'index.json')
    const receiptPath = join(capsules, '.uploaded-capsules.tsv')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      capsules: Array<{ archive: string; sha256: string }>
    }
    const capsule = index.capsules[0]
    assert.ok(capsule)

    const pending = spawnSync(
      process.execPath,
      [resolve('scripts/list-terminal-bench-pending-capsules.mts'), indexPath, receiptPath],
      { encoding: 'utf8' },
    )
    assert.equal(pending.status, 0, pending.stderr)
    assert.equal(pending.stdout, `${capsule.sha256}\t${capsule.archive}\n`)

    writeFileSync(receiptPath, pending.stdout)
    const uploaded = spawnSync(
      process.execPath,
      [resolve('scripts/list-terminal-bench-pending-capsules.mts'), indexPath, receiptPath],
      { encoding: 'utf8' },
    )
    assert.equal(uploaded.status, 0, uploaded.stderr)
    assert.equal(uploaded.stdout, '')
  })

  it('refuses to seal a trial that leaked a configured secret', () => {
    const secret = 'test-secret-value-123456'
    const root = fixture(`tool output accidentally contained ${secret}`)
    const sealed = runSeal(root, { SCW_GENERATIVE_API_KEY: secret })
    assert.notEqual(sealed.status, 0)
    assert.match(String(sealed.stderr), /contains SCW_GENERATIVE_API_KEY/)
    assert.doesNotMatch(String(sealed.stderr), new RegExp(secret))
  })

  it('numbers attempts independently within each profile', () => {
    const root = fixture()
    const source = join(root, 'bench-results', 'terminal-bench', 'job', 'trial')
    const target = join(root, 'bench-results', 'terminal-bench', 'job', 'trial-product')
    cpSync(source, target, { recursive: true })
    const resultPath = join(target, 'result.json')
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
    const agentResult = result['agent_result'] as Record<string, unknown>
    const metadata = agentResult['metadata'] as Record<string, unknown>
    metadata['profile'] = 'product-aligned@1'
    metadata['profile_hash'] = terminalBenchProfile('product-aligned@1').contentHash
    result['started_at'] = '2026-07-21T11:00:00Z'
    result['finished_at'] = '2026-07-21T11:01:00Z'
    writeFileSync(resultPath, JSON.stringify(result))

    const sealed = runSeal(root)
    assert.equal(sealed.status, 0, String(sealed.stderr))
    const index = JSON.parse(
      readFileSync(join(root, 'bench-results', 'terminal-bench-capsules', 'index.json'), 'utf8'),
    ) as { capsules: Array<{ attemptIndex: number; profile: string }> }
    assert.deepEqual(
      index.capsules.map((capsule) => [capsule.profile, capsule.attemptIndex]).sort(),
      [
        ['main-legacy@1', 1],
        ['product-aligned@1', 1],
      ],
    )
  })

  it('seals an infrastructure-invalid trial under its retained profile', () => {
    const root = fixture()
    const trial = join(root, 'bench-results', 'terminal-bench', 'job', 'trial')
    const resultPath = join(trial, 'result.json')
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
    result['agent_result'] = null
    result['exception_info'] = { exception_type: 'RuntimeError', message: 'container failed' }
    result['verifier_result'] = null
    writeFileSync(resultPath, JSON.stringify(result))
    const profile = terminalBenchProfile('product-aligned')
    writeFileSync(
      join(trial, 'terminal-bench-profile.json'),
      JSON.stringify({
        schemaVersion: 1,
        profile: profile.versionedId,
        contentHash: profile.contentHash,
      }),
    )

    const sealed = runSeal(root, { COPSE_TERMINAL_PROFILE: 'main-legacy' })
    assert.equal(sealed.status, 0, String(sealed.stderr))
    const index = JSON.parse(
      readFileSync(join(root, 'bench-results', 'terminal-bench-capsules', 'index.json'), 'utf8'),
    ) as { capsules: Array<{ outcome: string; profile: string }> }
    assert.deepEqual(
      index.capsules.map(({ outcome, profile: id }) => [id, outcome]),
      [['product-aligned@3', 'invalid']],
    )
  })
})
