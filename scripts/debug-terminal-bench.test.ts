import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { c as createTar } from 'tar'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

async function fixture(): Promise<{
  env: NodeJS.ProcessEnv
  output: string
}> {
  const root = mkdtempSync(join(tmpdir(), 'copse-terminal-debug-cli-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const storage = join(root, 'storage')
  const output = join(root, 'output')
  const prefix = join(
    storage,
    'debug-bucket',
    'terminal-bench',
    'copse-dev',
    'agent-pane',
    '12345',
    '1',
  )
  const shard = join(prefix, 'shard-0')
  const trial = join(root, 'trial')
  mkdirSync(join(trial, 'agent', 'thread'), { recursive: true })
  mkdirSync(shard, { recursive: true })
  mkdirSync(bin)
  const thread = '{"type":"thread","id":"thread-1"}\n'
  writeFileSync(join(trial, 'agent', 'thread', 'thread.jsonl'), thread)
  writeFileSync(join(trial, 'result.json'), '{"task_name":"debug-task"}\n')
  const archive = 'debug-task-trial-1.tar.gz'
  const archivePath = join(shard, archive)
  await createTar({ cwd: trial, file: archivePath, gzip: true, portable: true }, ['.'])
  const archiveContents = readFileSync(archivePath)
  writeFileSync(
    join(shard, 'index.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      capsules: [
        {
          trialId: 'trial-1',
          taskName: 'debug-task',
          archive,
          bytes: statSync(archivePath).size,
          sha256: createHash('sha256').update(archiveContents).digest('hex'),
          startedAt: '2026-07-22T10:00:00Z',
          outcome: 'zero',
        },
      ],
    })}\n`,
  )
  writeFileSync(
    join(prefix, 'run.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'terminal-bench-run',
      repository: 'copse-dev/agent-pane',
      workflowRunId: '12345',
      workflowRunAttempt: 1,
      suiteRunId: 'github-12345-1',
      objectPrefix: 'terminal-bench/copse-dev/agent-pane/12345/1',
      shardCount: 1,
      maxTasks: 1,
      attempts: 1,
      model: 'model-id',
      sourceCommit: 'abc123',
      createdAt: '2026-07-22T10:00:00.000Z',
    })}\n`,
  )

  const aws = join(bin, 'aws')
  writeFileSync(
    aws,
    `#!/usr/bin/env node
const { copyFileSync } = require('node:fs')
const { join } = require('node:path')
if (process.argv[2] === '--version') process.exit(0)
const source = process.argv[4]
const destination = process.argv[5]
if (process.argv[2] !== 's3' || process.argv[3] !== 'cp' || !source.startsWith('s3://')) process.exit(2)
const parsed = new URL(source)
try {
  copyFileSync(join(process.env.FAKE_S3_ROOT, parsed.hostname, decodeURIComponent(parsed.pathname)), destination)
} catch {
  process.exit(1)
}
`,
  )
  chmodSync(aws, 0o755)
  return {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      FAKE_S3_ROOT: storage,
      SCW_OBJECT_STORAGE_READER_ACCESS_KEY_ID: 'reader-access',
      SCW_OBJECT_STORAGE_READER_SECRET_KEY: 'reader-secret',
    },
    output,
  }
}

function runDebug(args: readonly string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [resolve('scripts/debug-terminal-bench.mts'), ...args], {
    encoding: 'utf8',
    env,
  })
}

test('debug CLI lists, verifies, safely extracts, and prints a retained thread', async () => {
  const prepared = await fixture()
  const common = [
    '--run',
    '12345',
    '--repository',
    'copse-dev/agent-pane',
    '--bucket',
    'debug-bucket',
    '--output',
    prepared.output,
  ]
  const listed = runDebug(['list', ...common, '--json'], prepared.env)
  assert.equal(listed.status, 0, String(listed.stderr))
  const capsules: unknown = JSON.parse(String(listed.stdout))
  assert.ok(Array.isArray(capsules))
  assert.equal(Reflect.get(capsules[0], 'trialId'), 'trial-1')
  assert.equal(Reflect.get(capsules[0], 'outcome'), 'zero')

  const thread = runDebug(['thread', ...common, '--task', 'debug-task'], prepared.env)
  assert.equal(thread.status, 0, String(thread.stderr))
  assert.equal(String(thread.stdout), '{"type":"thread","id":"thread-1"}\n')
  const marker: unknown = JSON.parse(
    readFileSync(join(prepared.output, 'trial-1', '.capsule.json'), 'utf8'),
  )
  assert.ok(typeof marker === 'object' && marker !== null)
  assert.equal(Reflect.get(marker, 'trialId'), 'trial-1')
})
