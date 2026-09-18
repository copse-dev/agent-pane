import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  containerBuildCommand,
  containerHostName,
  containerImageInspectCommand,
  normalizeContainerScriptArgs,
  parseContainerEnginePreference,
  resolveContainerEngine,
  type ContainerEngineProbe,
} from './container-engine.mts'

function probeWith(results: Readonly<Record<string, boolean>>): ContainerEngineProbe {
  return {
    probe(command, args): { ok: boolean; detail: string } {
      const key = [command, ...args].join(' ')
      return { ok: results[key] ?? false, detail: `${key} unavailable` }
    },
  }
}

describe('container engine selection', () => {
  it('accepts pnpm forwarding with or without a separator sentinel', () => {
    assert.deepEqual(normalizeContainerScriptArgs(['--', '--no-build']), ['--no-build'])
    assert.deepEqual(normalizeContainerScriptArgs(['--no-build']), ['--no-build'])
  })

  it('prefers a ready Apple container service on Apple silicon', () => {
    assert.equal(
      resolveContainerEngine({
        env: {},
        platform: 'darwin',
        architecture: 'arm64',
        probe: probeWith({
          'container --version': true,
          'container system status': true,
          'docker info --format {{.ServerVersion}}': true,
        }),
      }),
      'apple',
    )
  })

  it('falls back to Docker before a run when Apple container is not ready', () => {
    assert.equal(
      resolveContainerEngine({
        env: {},
        platform: 'darwin',
        architecture: 'arm64',
        probe: probeWith({
          'container --version': true,
          'container system status': false,
          'docker info --format {{.ServerVersion}}': true,
        }),
      }),
      'docker',
    )
  })

  it('honors an explicit engine without silently falling back', () => {
    assert.throws(
      () =>
        resolveContainerEngine({
          env: { COPSE_CONTAINER_ENGINE: 'apple' },
          platform: 'darwin',
          architecture: 'arm64',
          probe: probeWith({
            'container --version': true,
            'container system status': false,
            'docker info --format {{.ServerVersion}}': true,
          }),
        }),
      /Apple container is unavailable.*container system start/,
    )
  })

  it('rejects Apple container on unsupported hosts', () => {
    assert.throws(
      () =>
        resolveContainerEngine({
          env: { COPSE_CONTAINER_ENGINE: 'apple' },
          platform: 'linux',
          architecture: 'arm64',
          probe: probeWith({}),
        }),
      /requires macOS/,
    )
    assert.throws(
      () =>
        resolveContainerEngine({
          env: { COPSE_CONTAINER_ENGINE: 'apple' },
          platform: 'darwin',
          architecture: 'x64',
          probe: probeWith({}),
        }),
      /requires Apple silicon/,
    )
  })

  it('validates the public preference value', () => {
    assert.equal(parseContainerEnginePreference(undefined), 'auto')
    assert.equal(parseContainerEnginePreference(' APPLE '), 'apple')
    assert.throws(() => parseContainerEnginePreference('podman'), /auto, docker, or apple/)
  })
})

describe('container engine command mapping', () => {
  const spec = {
    file: 'ci-runners/Dockerfile',
    tag: 'copse-ci-runner:latest',
    context: 'ci-runners',
    architecture: 'amd64',
    pull: true,
    cpus: 4,
    memory: '8g',
    buildArgs: { TARGET_REF: 'main', TARGET_REPO: 'copse-dev/agent-pane' },
    secrets: [{ id: 'gh_token', env: 'BUILD_GH_TOKEN' }],
  } as const

  it('builds through Docker with a Linux platform', () => {
    assert.deepEqual(containerBuildCommand('docker', spec), {
      command: 'docker',
      args: [
        'build',
        '--file',
        'ci-runners/Dockerfile',
        '--tag',
        'copse-ci-runner:latest',
        '--pull',
        '--platform',
        'linux/amd64',
        '--build-arg',
        'TARGET_REF=main',
        '--build-arg',
        'TARGET_REPO=copse-dev/agent-pane',
        '--secret',
        'id=gh_token,env=BUILD_GH_TOKEN',
        'ci-runners',
      ],
    })
  })

  it('builds through Apple container with explicit builder resources', () => {
    assert.deepEqual(containerBuildCommand('apple', spec), {
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
        'TARGET_REF=main',
        '--build-arg',
        'TARGET_REPO=copse-dev/agent-pane',
        '--secret',
        'id=gh_token,env=BUILD_GH_TOKEN',
        'ci-runners',
      ],
    })
  })

  it('maps image inspection and host integration names', () => {
    assert.deepEqual(containerImageInspectCommand('apple', 'example:latest'), {
      command: 'container',
      args: ['image', 'inspect', 'example:latest'],
    })
    assert.equal(containerHostName('apple'), 'host.container.internal')
    assert.equal(containerHostName('docker'), 'host.docker.internal')
  })
})
