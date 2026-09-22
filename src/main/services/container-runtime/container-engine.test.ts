import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dockerDaemonReachable,
  requireDockerForThreadContainer,
  type CommandProbeResult,
  type ContainerEngineProbe,
} from './container-engine.ts'

function probeMap(map: Record<string, boolean | string>): ContainerEngineProbe {
  return {
    probe(command, args): CommandProbeResult {
      const key = `${command} ${args.join(' ')}`
      const entry = map[key]
      if (entry === true) return { ok: true, detail: 'ok' }
      if (entry === false) return { ok: false, detail: `${key} failed` }
      if (typeof entry === 'string') return { ok: false, detail: entry }
      return { ok: false, detail: `unexpected probe ${key}` }
    },
  }
}

describe('requireDockerForThreadContainer', () => {
  it('accepts a reachable Docker daemon', () => {
    assert.equal(
      requireDockerForThreadContainer({
        platform: 'darwin',
        architecture: 'arm64',
        probe: probeMap({ 'docker info --format {{.ServerVersion}}': true }),
      }),
      'docker',
    )
  })

  it('fails with a recovery path when Docker is down', () => {
    assert.throws(
      () =>
        requireDockerForThreadContainer({
          platform: 'linux',
          architecture: 'x64',
          probe: probeMap({
            'docker info --format {{.ServerVersion}}':
              'dial unix /Users/me/.docker/run/docker.sock: connect: no such file or directory',
          }),
        }),
      /need a running Docker daemon before the worker image is built[\s\S]*Start Docker Desktop/,
    )
  })

  it('names a ready Apple container when Docker is down on Apple silicon', () => {
    assert.throws(
      () =>
        requireDockerForThreadContainer({
          platform: 'darwin',
          architecture: 'arm64',
          probe: probeMap({
            'docker info --format {{.ServerVersion}}': 'daemon down',
            'container --version': true,
            'container system status': true,
          }),
        }),
      /Apple container is running on this Mac[\s\S]*still require Docker[\s\S]*COPSE_CONTAINER_ENGINE=apple/,
    )
  })

  it('does not claim Apple support on non-Apple hosts', () => {
    assert.throws(
      () =>
        requireDockerForThreadContainer({
          platform: 'darwin',
          architecture: 'x64',
          probe: probeMap({
            'docker info --format {{.ServerVersion}}': 'daemon down',
            'container --version': true,
            'container system status': true,
          }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /need a running Docker daemon/)
        assert.doesNotMatch(error.message, /Apple container is running/)
        return true
      },
    )
  })
})

describe('dockerDaemonReachable', () => {
  it('mirrors the Docker probe', () => {
    assert.equal(
      dockerDaemonReachable({
        probe: probeMap({ 'docker info --format {{.ServerVersion}}': true }),
      }),
      true,
    )
    assert.equal(
      dockerDaemonReachable({
        probe: probeMap({ 'docker info --format {{.ServerVersion}}': false }),
      }),
      false,
    )
  })
})
