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
import { expectRecord } from '../src/shared/unknown-value.mts'

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
  const result = expectRecord(JSON.parse(readFileSync(resultPath, 'utf8')) as unknown)
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

function readCapsulesIndex(path: string): Record<string, unknown>[] {
  const index = expectRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  const capsules = index['capsules']
  assert.ok(Array.isArray(capsules))
  return capsules.map((entry: unknown) => expectRecord(entry))
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
      typeof index === 'object' && index !== null ? expectRecord(index)['capsules'] : undefined
    assert.ok(Array.isArray(entries))
    assert.equal(entries.length, 1)
    const entry = (entries as unknown[])[0]
    assert.equal(typeof entry, 'object')
    const archive =
      typeof entry === 'object' && entry !== null ? expectRecord(entry)['archive'] : undefined
    const digest =
      typeof entry === 'object' && entry !== null ? expectRecord(entry)['sha256'] : undefined
    const outcome =
      typeof entry === 'object' && entry !== null ? expectRecord(entry)['outcome'] : undefined
    assert.equal(typeof archive, 'string')
    assert.match(String(digest), /^[a-f0-9]{64}$/)
    assert.equal(outcome, 'zero')
    assert.equal(expectRecord(entry)['profile'], 'main-legacy@1')
    assert.ok(readFileSync(join(capsules, String(archive))).length > 0)

    const trialManifest: unknown = JSON.parse(
      readFileSync(
        join(root, 'bench-results', 'terminal-bench', 'job', 'trial', 'run-manifest.json'),
        'utf8',
      ),
    )
    assert.equal(expectRecord(trialManifest)['schemaVersion'], 2)
    const dataset = expectRecord(expectRecord(trialManifest)['dataset'])
    const profile = expectRecord(expectRecord(trialManifest)['profile'])
    const metrics = expectRecord(expectRecord(trialManifest)['metrics'])
    const infrastructure = expectRecord(expectRecord(trialManifest)['infrastructure'])
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
    const firstIndex = readCapsulesIndex(join(capsules, 'index.json'))
    const archive = firstIndex[0]
    assert.ok(archive)
    assert.equal(typeof archive['archive'], 'string')

    const second = runSeal(root)
    assert.equal(second.status, 0, String(second.stderr))
    assert.match(
      String(second.stdout),
      new RegExp(`bench:terminal:seal reused ${String(archive['archive'])}`),
    )
    assert.doesNotMatch(String(second.stdout), /bench:terminal:seal bench-results\//)
    const secondIndex = readCapsulesIndex(join(capsules, 'index.json'))
    assert.deepEqual(secondIndex, firstIndex)
  })

  it('lists only capsules without a matching local upload receipt', () => {
    const root = fixture()
    const sealed = runSeal(root)
    assert.equal(sealed.status, 0, String(sealed.stderr))
    const capsules = join(root, 'bench-results', 'terminal-bench-capsules')
    const indexPath = join(capsules, 'index.json')
    const receiptPath = join(capsules, '.uploaded-capsules.tsv')
    const index = readCapsulesIndex(indexPath)
    const capsule = index[0]
    assert.ok(capsule)
    assert.equal(typeof capsule['sha256'], 'string')
    assert.equal(typeof capsule['archive'], 'string')

    const pending = spawnSync(
      process.execPath,
      [resolve('scripts/list-terminal-bench-pending-capsules.mts'), indexPath, receiptPath],
      { encoding: 'utf8' },
    )
    assert.equal(pending.status, 0, pending.stderr)
    assert.equal(pending.stdout, `${String(capsule['sha256'])}\t${String(capsule['archive'])}\n`)

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
    const result = expectRecord(JSON.parse(readFileSync(resultPath, 'utf8')) as unknown)
    const agentResult = expectRecord(result['agent_result'])
    const metadata = expectRecord(agentResult['metadata'])
    metadata['profile'] = 'product-aligned@1'
    metadata['profile_hash'] = terminalBenchProfile('product-aligned@1').contentHash
    result['started_at'] = '2026-07-21T11:00:00Z'
    result['finished_at'] = '2026-07-21T11:01:00Z'
    writeFileSync(resultPath, JSON.stringify(result))

    const sealed = runSeal(root)
    assert.equal(sealed.status, 0, String(sealed.stderr))
    const index = readCapsulesIndex(
      join(root, 'bench-results', 'terminal-bench-capsules', 'index.json'),
    )
    assert.deepEqual(index.map((capsule) => [capsule['profile'], capsule['attemptIndex']]).sort(), [
      ['main-legacy@1', 1],
      ['product-aligned@1', 1],
    ])
  })

  it('seals an infrastructure-invalid trial under its retained profile', () => {
    const root = fixture()
    const trial = join(root, 'bench-results', 'terminal-bench', 'job', 'trial')
    const resultPath = join(trial, 'result.json')
    const result = expectRecord(JSON.parse(readFileSync(resultPath, 'utf8')) as unknown)
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
    const index = readCapsulesIndex(
      join(root, 'bench-results', 'terminal-bench-capsules', 'index.json'),
    )
    assert.deepEqual(
      index.map((capsule) => [capsule['profile'], capsule['outcome']]),
      [['product-aligned@3', 'invalid']],
    )
  })
})
