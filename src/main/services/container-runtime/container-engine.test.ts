import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  containerBuildCommand,
  containerEngineInvocation,
  runLockedContainerBuild,
  dockerDaemonReachable,
  engineCommand,
  reachableThreadContainerEngines,
  resolveThreadContainerEngine,
  runContainerImageBuild,
  type CommandProbeResult,
  type ContainerEngineProbe,
} from './container-engine.ts'

const DOCKER = 'docker info --format {{.ServerVersion}}'
const APPLE_VERSION = 'container --version'
const APPLE_STATUS = 'container system status'

describe('container image build concurrency', () => {
  it('locks only Apple builds, keeping one per-user inode and bounding the wait', () => {
    const args = ['build', '--tag', 'worker:test', '/context']
    const invocation = containerEngineInvocation('apple', args)
    assert.equal(invocation.command, '/usr/bin/lockf')
    assert.deepEqual(invocation.args.slice(0, 3), ['-k', '-t', '900'])
    assert.match(
      invocation.args[3] ?? '',
      /^\/private\/tmp\/copse-apple-builder-(?:\d+|unknown)\.lock$/,
    )
    assert.deepEqual(invocation.args.slice(4), ['container', ...args])
    assert.deepEqual(containerEngineInvocation('docker', args), { command: 'docker', args })
    assert.deepEqual(containerEngineInvocation('apple', ['start', 'worker']), {
      command: 'container',
      args: ['start', 'worker'],
    })
  })

  it(
    'serializes separate macOS processes and releases a failed command’s lock',
    {
      skip: process.platform !== 'darwin',
      timeout: 10_000,
    },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'copse-build-lock-test-'))
      const lock = join(directory, 'builder.lock')
      const events = join(directory, 'events.txt')
      const invocation = containerEngineInvocation('apple', ['build'])
      const execute = promisify(execFile)
      // Inject the native command and lock-file fixtures at the subprocess
      // boundary. Each call is its own process, with no JS queue protecting it.
      const run = (name: string): Promise<{ stdout: string; stderr: string }> =>
        execute(invocation.command, [
          ...invocation.args.slice(0, 3),
          lock,
          process.execPath,
          '-e',
          `const fs = require('node:fs');
         fs.appendFileSync(process.argv[1], 'start:' + process.argv[2] + '\\n');
         if (process.argv[2] === 'fail') process.exit(42);
         setTimeout(() => fs.appendFileSync(process.argv[1], 'end:' + process.argv[2] + '\\n'), 50);`,
          events,
          name,
        ])
      try {
        await assert.rejects(run('fail'), { code: 42 })
        await Promise.all([run('a'), run('b')])
        const rows = readFileSync(events, 'utf8').trim().split('\n')
        assert.equal(rows[0], 'start:fail')
        assert.equal(rows.length, 5)
        assert.equal(rows[2], rows[1]?.replace('start:', 'end:'))
        assert.equal(rows[4], rows[3]?.replace('start:', 'end:'))
        assert.notEqual(rows[1], rows[3])
        assert.equal(existsSync(lock), true)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it(
    'kills the locked build child at its deadline before a new caller acquires the lock',
    { skip: process.platform !== 'darwin', timeout: 10_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'copse-build-deadline-test-'))
      const lock = join(directory, 'builder.lock')
      const events = join(directory, 'events.txt')
      const invocation = containerEngineInvocation('apple', ['build'])
      try {
        await assert.rejects(
          runLockedContainerBuild(
            {
              command: invocation.command,
              args: [
                ...invocation.args.slice(0, 3),
                lock,
                process.execPath,
                '-e',
                `const fs = require('node:fs');
                 fs.appendFileSync(process.argv[1], 'start\\n');
                 setTimeout(() => fs.appendFileSync(process.argv[1], 'orphan-completed\\n'), 1800);`,
                events,
              ],
            },
            { timeoutMs: 1200 },
          ),
          /exceeded its deadline/,
        )
        await runLockedContainerBuild(
          {
            command: invocation.command,
            args: [
              ...invocation.args.slice(0, 3),
              lock,
              process.execPath,
              '-e',
              `require('node:fs').appendFileSync(process.argv[1], 'second\\n')`,
              events,
            ],
          },
          { timeoutMs: 1200 },
        )
        await new Promise((resolve) => setTimeout(resolve, 800))
        assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n'), ['start', 'second'])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('queues Apple builds, allows Docker through, and releases the queue after failure', async () => {
    const events: string[] = []
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = runContainerImageBuild('apple', async () => {
      events.push('first')
      await blocked
      throw new Error('first build failed')
    })
    // Attach the rejection handler before releasing the failed build.
    const failed = assert.rejects(first, /first build failed/)
    const second = runContainerImageBuild('apple', async () => {
      events.push('second')
      return 'built'
    })
    await runContainerImageBuild('docker', async () => {
      events.push('docker')
    })
    assert.deepEqual(events, ['docker', 'first'])
    release()
    await failed
    assert.equal(await second, 'built')
    assert.deepEqual(events, ['docker', 'first', 'second'])
  })
})

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
