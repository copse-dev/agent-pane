import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  parseTerminalBenchRunManifest,
  parseTerminalBenchShardIndex,
  repositoryFromGitRemote,
  selectTerminalBenchCapsule,
  terminalBenchArchiveEntryPath,
  terminalBenchArchiveEntryTypeAllowed,
  terminalBenchRunPrefix,
  verifyTerminalBenchCapsule,
} from './terminal-bench-debug.mts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function runManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'terminal-bench-run',
    repository: 'copse-dev/agent-pane',
    workflowRunId: '12345',
    workflowRunAttempt: 2,
    suiteRunId: 'github-12345-2',
    objectPrefix: 'terminal-bench/copse-dev/agent-pane/12345/2',
    shardCount: 3,
    maxTasks: 10,
    attempts: 1,
    model: 'model-id',
    sourceCommit: 'abc123',
    createdAt: '2026-07-22T10:00:00.000Z',
  }
}

describe('Terminal-Bench post-run debugging', () => {
  it('derives and validates an exact workflow-run object prefix', () => {
    assert.equal(
      terminalBenchRunPrefix('copse-dev/agent-pane', '12345', 2),
      'terminal-bench/copse-dev/agent-pane/12345/2',
    )
    assert.equal(parseTerminalBenchRunManifest(runManifest()).shardCount, 3)
    assert.throws(
      () =>
        parseTerminalBenchRunManifest({
          ...runManifest(),
          objectPrefix: 'terminal-bench/another/run',
        }),
      /does not match/,
    )
  })

  it('parses v2 dataset and profile provenance while retaining v1 compatibility', () => {
    const parsed = parseTerminalBenchRunManifest({
      ...runManifest(),
      schemaVersion: 2,
      dataset: {
        id: 'terminal-bench/terminal-bench-2-1',
        version: '2.1',
        revision: 'upstream-commit',
      },
      profile: {
        id: 'main-legacy',
        versionedId: 'main-legacy@1',
        contentHash: 'a'.repeat(64),
      },
    })
    assert.equal(parsed.schemaVersion, 2)
    assert.equal(parsed.dataset?.version, '2.1')
    assert.equal(parsed.profile?.versionedId, 'main-legacy@1')
    assert.equal(parseTerminalBenchRunManifest(runManifest()).schemaVersion, 1)
  })

  it('parses shard indexes and selects the latest attempt for a task', () => {
    const capsules = parseTerminalBenchShardIndex(
      {
        schemaVersion: 1,
        capsules: [
          {
            trialId: 'trial-old',
            taskName: 'debug-task',
            archive: 'old.tar.gz',
            bytes: 12,
            sha256: 'a'.repeat(64),
            startedAt: '2026-07-22T10:00:00Z',
            outcome: 'zero',
          },
          {
            trialId: 'trial-new',
            taskName: 'debug-task',
            archive: 'new.tar.gz',
            bytes: 20,
            sha256: 'b'.repeat(64),
            startedAt: '2026-07-22T11:00:00Z',
            outcome: 'pass',
          },
        ],
      },
      4,
    )
    assert.equal(
      selectTerminalBenchCapsule(capsules, { taskName: 'debug-task' }).trialId,
      'trial-new',
    )
    assert.equal(selectTerminalBenchCapsule(capsules, { trialId: 'trial-old' }).shardIndex, 4)
    assert.throws(() => selectTerminalBenchCapsule(capsules, {}), /exactly one/)

    const v2 = parseTerminalBenchShardIndex(
      {
        schemaVersion: 2,
        capsules: [
          {
            trialId: 'trial-profiled',
            taskName: 'debug-task',
            archive: 'profiled.tar.gz',
            bytes: 12,
            sha256: 'c'.repeat(64),
            attemptIndex: 3,
            profile: 'product-aligned@1',
            profileHash: 'd'.repeat(64),
          },
        ],
      },
      5,
    )
    assert.equal(v2[0]?.attemptIndex, 3)
    assert.equal(v2[0].profile, 'product-aligned@1')
  })

  it('rejects unsafe capsule metadata and archive entries', () => {
    assert.throws(
      () =>
        parseTerminalBenchShardIndex(
          {
            schemaVersion: 1,
            capsules: [
              {
                trialId: '../trial',
                taskName: 'debug-task',
                archive: 'trial.tar.gz',
                bytes: 1,
                sha256: 'a'.repeat(64),
              },
            ],
          },
          0,
        ),
      /trialId is unsafe/,
    )
    assert.equal(
      terminalBenchArchiveEntryPath('./agent/thread/thread.jsonl'),
      'agent/thread/thread.jsonl',
    )
    assert.equal(terminalBenchArchiveEntryPath('../outside'), undefined)
    assert.equal(terminalBenchArchiveEntryPath('agent/../outside'), undefined)
    assert.equal(terminalBenchArchiveEntryPath('/absolute'), undefined)
    assert.equal(terminalBenchArchiveEntryPath('C:\\outside'), undefined)
    assert.equal(terminalBenchArchiveEntryTypeAllowed('File'), true)
    assert.equal(terminalBenchArchiveEntryTypeAllowed('SymbolicLink'), false)
  })

  it('verifies capsule size and SHA-256 before extraction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-terminal-debug-test-'))
    roots.push(root)
    const path = join(root, 'capsule.tar.gz')
    const contents = Buffer.from('capsule bytes')
    writeFileSync(path, contents)
    const digest = createHash('sha256').update(contents).digest('hex')
    await verifyTerminalBenchCapsule(path, contents.length, digest)
    await assert.rejects(
      () => verifyTerminalBenchCapsule(path, contents.length, '0'.repeat(64)),
      /mismatch/,
    )
    await assert.rejects(
      () => verifyTerminalBenchCapsule(path, contents.length + 1, digest),
      /size mismatch/,
    )
  })

  it('derives repository identity from SSH and HTTPS GitHub remotes', () => {
    assert.equal(
      repositoryFromGitRemote('git@github.com:copse-dev/agent-pane.git'),
      'copse-dev/agent-pane',
    )
    assert.equal(
      repositoryFromGitRemote('https://github.com/copse-dev/agent-pane.git'),
      'copse-dev/agent-pane',
    )
    assert.equal(repositoryFromGitRemote('https://example.com/copse-dev/agent-pane.git'), undefined)
  })

  it('writes a workflow run manifest with the effective shard count', () => {
    const written = spawnSync(
      process.execPath,
      [resolve('scripts/write-terminal-bench-run-manifest.mts')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'copse-dev/agent-pane',
          GITHUB_RUN_ID: '12345',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_SHA: 'abc123',
          COPSE_BENCH_RUN_ID: 'github-12345-2',
          COPSE_TERMINAL_MAX_TASKS: '3',
          COPSE_TERMINAL_INSTANCES: '10',
          COPSE_TERMINAL_ATTEMPTS: '1',
          LM_STUDIO_MODEL: 'model-id',
          COPSE_TERMINAL_PROFILE: 'product-aligned',
        },
      },
    )
    assert.equal(written.status, 0, written.stderr)
    const manifest = parseTerminalBenchRunManifest(JSON.parse(written.stdout))
    assert.equal(manifest.shardCount, 3)
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.dataset?.id, 'terminal-bench/terminal-bench-2-1')
    assert.equal(manifest.profile?.versionedId, 'product-aligned@1')
    assert.equal(manifest.objectPrefix, 'terminal-bench/copse-dev/agent-pane/12345/2')
  })
})
