import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  APPLE_RUNNER_DEFAULT_LABELS,
  appleRunnerBuildCommand,
  appleRunnerName,
  appleRunnerProbeArgs,
  appleRunnerRunArgs,
  appleRunnerStopArgs,
  defaultAppleRunnerLabels,
  positiveRunnerCount,
} from './apple-container-runners.mts'

describe('Apple container runner commands', () => {
  it('builds the portable runner image for amd64 with an optional BuildKit secret', () => {
    assert.deepEqual(
      appleRunnerBuildCommand({
        architecture: 'amd64',
        targetRepo: 'copse-dev/agent-pane',
        targetRef: 'main',
        hasBuildToken: true,
      }),
      {
        command: 'container',
        args: [
          'build',
          '--file',
          'ci-runners/Dockerfile',
          '--tag',
          'copse-ci-runner:latest',
          '--pull',
          '--arch',
          'amd64',
          '--cpus',
          '4',
          '--memory',
          '8g',
          '--build-arg',
          'TARGET_REPO=copse-dev/agent-pane',
          '--build-arg',
          'TARGET_REF=main',
          '--secret',
          'id=gh_token,env=BUILD_GH_TOKEN',
          'ci-runners',
        ],
      },
    )
  })

  it('probes the exact namespace and procfs shape before runner registration', () => {
    assert.deepEqual(appleRunnerProbeArgs('amd64'), [
      'run',
      '--rm',
      '--arch',
      'amd64',
      '--masked-path',
      'NONE',
      '--read-only-path',
      'NONE',
      '--entrypoint',
      'bwrap',
      'copse-ci-runner:latest',
      '--new-session',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--unshare-net',
      '--unshare-pid',
      '--unshare-user',
      '--cap-drop',
      'ALL',
      '--proc',
      '/proc',
      '--',
      '/usr/bin/true',
    ])
  })

  it('runs a bounded ephemeral slot with truthful labels', () => {
    const args = appleRunnerRunArgs(2, {
      architecture: 'amd64',
      envFile: '/repo/ci-runners/.env',
      labels: APPLE_RUNNER_DEFAULT_LABELS,
      namePrefix: 'apple-studio',
    })

    assert.deepEqual(args.slice(0, 18), [
      'run',
      '--rm',
      '--name',
      'copse-ci-runner-2',
      '--arch',
      'amd64',
      '--memory',
      '6g',
      '--cpus',
      '2',
      '--shm-size',
      '2g',
      '--init',
      '--masked-path',
      'NONE',
      '--read-only-path',
      'NONE',
      '--label',
    ])
    assert.ok(args.includes(`RUNNER_LABELS=${APPLE_RUNNER_DEFAULT_LABELS}`))
    assert.ok(args.includes('RUNNER_NAME=apple-studio-2'))
    assert.ok(!args.includes('--volume'))
    assert.ok(!args.some((arg) => arg === 'docker'))
  })

  it('uses deterministic owned names for graceful shutdown', () => {
    assert.equal(appleRunnerName(1), 'copse-ci-runner-1')
    assert.deepEqual(appleRunnerStopArgs([1, 3]), [
      'stop',
      '--time',
      '30',
      'copse-ci-runner-1',
      'copse-ci-runner-3',
    ])
  })

  it('advertises the architecture the Linux guest actually runs', () => {
    assert.equal(defaultAppleRunnerLabels('amd64'), APPLE_RUNNER_DEFAULT_LABELS)
    assert.equal(
      defaultAppleRunnerLabels('arm64'),
      'self-hosted,linux,arm64,apple-container,copse-e2e,copse-checks',
    )
  })

  it('bounds runner counts and slots', () => {
    assert.equal(positiveRunnerCount(undefined, 3), 3)
    assert.equal(positiveRunnerCount('4'), 4)
    for (const invalid of ['0', '-1', '1.5', '65', 'wat']) {
      assert.throws(() => positiveRunnerCount(invalid), /between 1 and 64/)
    }
    assert.throws(() => appleRunnerName(0), /between 1 and 64/)
  })
})
