import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  containerBuildCommand,
  dockerDaemonReachable,
  engineCommand,
  reachableThreadContainerEngines,
  resolveThreadContainerEngine,
  type CommandProbeResult,
  type ContainerEngineProbe,
} from './container-engine.ts'

const DOCKER = 'docker info --format {{.ServerVersion}}'
const APPLE_VERSION = 'container --version'
const APPLE_STATUS = 'container system status'

function probeMap(map: Record<string, boolean | string>): ContainerEngineProbe & {
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    probe(command, args): Promise<CommandProbeResult> {
      const key = `${command} ${args.join(' ')}`
      asked.push(key)
      const entry = map[key]
      if (entry === true) return Promise.resolve({ ok: true, detail: 'ok' })
      if (entry === false) return Promise.resolve({ ok: false, detail: `${key} failed` })
      if (typeof entry === 'string') return Promise.resolve({ ok: false, detail: entry })
      return Promise.resolve({ ok: false, detail: `unexpected probe ${key}` })
    },
  }
}

const APPLE_SILICON = { platform: 'darwin', architecture: 'arm64' } as const
const APPLE_READY = { [APPLE_VERSION]: true, [APPLE_STATUS]: true }

describe('resolveThreadContainerEngine', () => {
  it('uses Docker when its daemon answers, even with Apple container ready', async () => {
    const probe = probeMap({ [DOCKER]: true, ...APPLE_READY })
    assert.equal(await resolveThreadContainerEngine({ ...APPLE_SILICON, env: {}, probe }), 'docker')
    assert.deepEqual(probe.asked, [DOCKER])
  })

  it('falls back to a ready Apple container on Apple silicon when Docker is down', async () => {
    assert.equal(
      await resolveThreadContainerEngine({
        ...APPLE_SILICON,
        env: {},
        probe: probeMap({ [DOCKER]: 'daemon down', ...APPLE_READY }),
      }),
      'apple',
    )
  })

  it('names both engines and both recoveries when neither is up on Apple silicon', async () => {
    await assert.rejects(
      resolveThreadContainerEngine({
        ...APPLE_SILICON,
        env: {},
        probe: probeMap({
          [DOCKER]: 'dial unix /Users/me/.docker/run/docker.sock: connect: no such file',
          [APPLE_VERSION]: true,
          [APPLE_STATUS]: 'apiserver is not running',
        }),
      }),
      /need a container engine[\s\S]*Docker is unavailable: dial unix[\s\S]*Apple container is unavailable: apiserver is not running[\s\S]*Start Docker Desktop[\s\S]*container system start/,
    )
  })

  it('never offers Apple container off Apple silicon', async () => {
    for (const host of [
      { platform: 'darwin', architecture: 'x64' },
      { platform: 'linux', architecture: 'arm64' },
    ] as const) {
      const probe = probeMap({ [DOCKER]: 'daemon down', ...APPLE_READY })
      await assert.rejects(
        resolveThreadContainerEngine({ ...host, env: {}, probe }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /Docker is unavailable[\s\S]*Start Docker Desktop/)
          assert.doesNotMatch(error.message, /Apple container/)
          return true
        },
      )
      assert.deepEqual(probe.asked, [DOCKER])
    }
  })

  it('honours COPSE_CONTAINER_ENGINE=apple without asking Docker, and refuses rather than falling back', async () => {
    const ready = probeMap({ [DOCKER]: true, ...APPLE_READY })
    assert.equal(
      await resolveThreadContainerEngine({
        ...APPLE_SILICON,
        env: { COPSE_CONTAINER_ENGINE: 'apple' },
        probe: ready,
      }),
      'apple',
    )
    assert.ok(!ready.asked.includes(DOCKER))
    await assert.rejects(
      resolveThreadContainerEngine({
        ...APPLE_SILICON,
        env: { COPSE_CONTAINER_ENGINE: 'apple' },
        probe: probeMap({ [DOCKER]: true, [APPLE_VERSION]: true, [APPLE_STATUS]: 'stopped' }),
      }),
      /COPSE_CONTAINER_ENGINE=apple, but Apple container is unavailable: stopped[\s\S]*container system start/,
    )
    await assert.rejects(
      resolveThreadContainerEngine({
        platform: 'linux',
        architecture: 'x64',
        env: { COPSE_CONTAINER_ENGINE: 'apple' },
        probe: probeMap(APPLE_READY),
      }),
      /COPSE_CONTAINER_ENGINE=apple, but Apple container requires macOS/,
    )
  })

  it('honours COPSE_CONTAINER_ENGINE=docker and refuses rather than falling back to Apple container', async () => {
    const probe = probeMap({ [DOCKER]: 'daemon down', ...APPLE_READY })
    await assert.rejects(
      resolveThreadContainerEngine({
        ...APPLE_SILICON,
        env: { COPSE_CONTAINER_ENGINE: 'docker' },
        probe,
      }),
      /COPSE_CONTAINER_ENGINE=docker, but Docker is unavailable: daemon down/,
    )
    assert.deepEqual(probe.asked, [DOCKER])
  })

  it('rejects an unknown preference', async () => {
    await assert.rejects(
      resolveThreadContainerEngine({
        ...APPLE_SILICON,
        env: { COPSE_CONTAINER_ENGINE: 'podman' },
        probe: probeMap({}),
      }),
      /Unsupported COPSE_CONTAINER_ENGINE="podman"/,
    )
  })
})

describe('reachableThreadContainerEngines', () => {
  it('lists every engine that answers, Apple container only on Apple silicon', async () => {
    const both = probeMap({ [DOCKER]: true, ...APPLE_READY })
    assert.deepEqual(await reachableThreadContainerEngines({ ...APPLE_SILICON, probe: both }), [
      'docker',
      'apple',
    ])
    assert.deepEqual(
      await reachableThreadContainerEngines({
        platform: 'linux',
        architecture: 'x64',
        probe: probeMap({ [DOCKER]: true, ...APPLE_READY }),
      }),
      ['docker'],
    )
    assert.deepEqual(
      await reachableThreadContainerEngines({
        ...APPLE_SILICON,
        probe: probeMap({ [DOCKER]: false, [APPLE_VERSION]: false }),
      }),
      [],
    )
  })
})

describe('dockerDaemonReachable', () => {
  it('mirrors the Docker probe', async () => {
    assert.equal(await dockerDaemonReachable({ probe: probeMap({ [DOCKER]: true }) }), true)
    assert.equal(await dockerDaemonReachable({ probe: probeMap({ [DOCKER]: false }) }), false)
  })
})

describe('containerBuildCommand', () => {
  const spec = {
    file: '/ctx/Dockerfile',
    tag: 'copse-worker:local',
    context: '/ctx',
    labels: { 'dev.copse.worker-fingerprint': 'abc' },
    buildArgs: { WORKER_UID: '1001' },
  }

  it('spells one build for each engine', () => {
    assert.equal(engineCommand('docker'), 'docker')
    assert.equal(engineCommand('apple'), 'container')
    const expected = [
      'build',
      '--file',
      '/ctx/Dockerfile',
      '--tag',
      'copse-worker:local',
      '--label',
      'dev.copse.worker-fingerprint=abc',
      '--build-arg',
      'WORKER_UID=1001',
      '/ctx',
    ]
    assert.deepEqual(containerBuildCommand('docker', spec), { command: 'docker', args: expected })
    assert.deepEqual(containerBuildCommand('apple', spec), { command: 'container', args: expected })
  })

  it('passes a build network to Docker and refuses one for Apple container', () => {
    assert.deepEqual(
      containerBuildCommand('docker', { ...spec, network: 'host' }).args.slice(5, 7),
      ['--network', 'host'],
    )
    assert.throws(
      () => containerBuildCommand('apple', { ...spec, network: 'host' }),
      /Apple container builds cannot take a build network/,
    )
  })
})
