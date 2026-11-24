import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  APPLE_CONTAINER_ENGINE,
  appleCellShortfall,
  appleCreateArgs,
  containerCreateArgs,
  createContainerBackend,
  defaultContainerEngines,
  detectContainerBackend,
  DEFAULT_CONTAINER_LIMITS,
  DOCKER_ENGINE,
  imageInspectArgs,
  PODMAN_ENGINE,
  type ContainerRunInput,
} from './container-backend.ts'
import { FAKE_IMAGE, writeFakeContainerEngine } from './fake-container-engine.ts'
import { cellEnvironment, type CellSpec, type ExecutionCell } from './isolation.ts'

const probeSchema = z.object({
  cwd: z.string(),
  home: z.string(),
  tmp: z.string(),
  path: z.string().optional(),
})

const recordSchema = z.object({
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  flags: z.array(z.string()),
  image: z.string(),
  argv: z.array(z.string()),
})

describe('container backend', () => {
  describe('run argv', () => {
    const input: ContainerRunInput = {
      name: 'copse-review-abc-1',
      image: 'copse-worker:local',
      labels: { 'dev.copse.managed': '1', 'dev.copse.runtime': 'abc-1' },
      user: { uid: 501, gid: 20 },
      limits: DEFAULT_CONTAINER_LIMITS,
      writable: ['/scratch/base', '/scratch/head', '/scratch'],
      readOnly: ['/Users/me/Library/pnpm/store', '/repo/.git'],
      cwd: '/scratch/head',
      env: { PATH: '/host/bin', CI: '1', HOME: '/scratch/home', npm_config_store_dir: '/x' },
      argv: ['pnpm', 'run', 'test'],
    }

    it('pins every wall the backend declares as a flag', () => {
      const args = containerCreateArgs(input)
      assert.deepEqual(args.slice(0, 5), [
        'create',
        '--rm',
        '--pull=never',
        '--name',
        'copse-review-abc-1',
      ])
      for (const flag of [
        '--init',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=512',
        '--memory=4g',
        '--cpus=2',
        '--network=none',
        '--user=501:20',
        '--tmpfs=/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777',
      ]) {
        assert.ok(args.includes(flag), `${flag} missing`)
      }
      assert.ok(args.includes('--label') && args.includes('dev.copse.runtime=abc-1'))
      assert.doesNotMatch(args.join(' '), /--privileged|--cap-add|docker\.sock/)
    })

    it('mounts checkouts and scratch read-write and the declared paths read-only, all at their host paths', () => {
      const args = containerCreateArgs(input)
      assert.ok(args.includes('--mount=type=bind,source=/scratch/head,target=/scratch/head'))
      assert.ok(args.includes('--mount=type=bind,source=/scratch,target=/scratch'))
      assert.ok(
        args.includes(
          '--mount=type=bind,source=/Users/me/Library/pnpm/store,target=/Users/me/Library/pnpm/store,readonly',
        ),
      )
      assert.ok(args.includes('--mount=type=bind,source=/repo/.git,target=/repo/.git,readonly'))
      assert.equal(args[args.indexOf('--workdir') + 1], '/scratch/head')
    })

    it('passes the cell environment minus PATH and overrides the image entrypoint', () => {
      const args = containerCreateArgs(input)
      assert.ok(args.includes('CI=1'))
      assert.ok(args.includes('npm_config_store_dir=/x'))
      assert.equal(
        args.some((arg) => arg.startsWith('PATH=')),
        false,
        'the host PATH must not reach the container',
      )
      assert.deepEqual(args.slice(-5), [
        '--entrypoint',
        'pnpm',
        'copse-worker:local',
        'run',
        'test',
      ])
    })

    it('leaves the user to the image when none is given', () => {
      const args = containerCreateArgs({ ...input, user: null })
      assert.equal(
        args.some((arg) => arg.startsWith('--user=')),
        false,
      )
    })

    it('spells every wall in Apple container dialect, with no-new-privileges set by setpriv', () => {
      const args = containerCreateArgs(input, 'apple')
      assert.deepEqual(args, appleCreateArgs(input))
      assert.deepEqual(args.slice(0, 3), ['create', '--name', 'copse-review-abc-1'])
      const pairs: [string, string][] = [
        ['--cap-drop', 'ALL'],
        ['--ulimit', 'nproc=512:512'],
        ['--memory', '4g'],
        ['--cpus', '2'],
        ['--network', 'none'],
        ['--user', '501:20'],
        ['--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777'],
        ['--workdir', '/scratch/head'],
      ]
      for (const [flag, value] of pairs) {
        assert.equal(args[args.indexOf(flag) + 1], value, `${flag} ${value}`)
      }
      assert.ok(args.includes('--init') && args.includes('--read-only'))
      // Apple container has neither flag; the backend deletes every container itself.
      assert.equal(args.includes('--rm'), false)
      assert.equal(
        args.some((arg) => arg.startsWith('--pull') || arg.startsWith('--security-opt')),
        false,
      )
      assert.ok(args.includes('/scratch/head:/scratch/head'))
      assert.ok(args.includes('/repo/.git:/repo/.git:ro'))
      assert.equal(
        args.some((arg) => arg.startsWith('PATH=')),
        false,
      )
      assert.deepEqual(args.slice(-8), [
        '--entrypoint',
        'setpriv',
        'copse-worker:local',
        '--no-new-privs',
        '--',
        'pnpm',
        'run',
        'test',
      ])
      assert.doesNotMatch(args.join(' '), /--privileged|--cap-add|docker\.sock/)
    })

    it('mounts a shared base and head checkout only once', () => {
      const args = containerCreateArgs({ ...input, writable: ['/scratch/head', '/scratch/head'] })
      assert.equal(
        args.filter((arg) => arg === '--mount=type=bind,source=/scratch/head,target=/scratch/head')
          .length,
        1,
      )
    })
  })

  it('declares container strength and every capability', () => {
    const backend = createContainerBackend({ image: FAKE_IMAGE })
    assert.equal(backend.id, 'container')
    assert.equal(backend.strength, 'container')
    assert.deepEqual(backend.capabilities, {
      filesystemConfined: true,
      secretFreeEnvironment: true,
      networkDenied: true,
      ephemeral: true,
    })
  })

  describe('over the fake engine', () => {
    let scratch = ''
    let registry = ''
    let spec: CellSpec
    let cell: ExecutionCell
    const commandIds: string[] = []

    before(async () => {
      scratch = await realpath(await mkdtemp(join(tmpdir(), 'review-container-backend-')))
      registry = join(scratch, 'registry')
      await mkdir(registry)
      const base = join(scratch, 'base')
      const head = join(scratch, 'head')
      await mkdir(base)
      await mkdir(head)
      const engine = await writeFakeContainerEngine(registry)
      spec = {
        checkouts: { base, head },
        scratchDir: scratch,
        readOnlyPaths: [join(scratch, 'store')],
        env: cellEnvironment({ PATH: process.env['PATH'], SECRET_TOKEN: 'ghp_notforthecell' }),
      }
      cell = await createContainerBackend({
        image: FAKE_IMAGE,
        engine,
        containerName: (id) => {
          commandIds.push(id)
          return `copse-${id}`
        },
        labels: (id) => ({ 'dev.copse.runtime': id }),
      }).createCell(spec)
    })

    after(async () => {
      await cell.destroy()
      await rm(scratch, { recursive: true, force: true })
    })

    async function lastRecord(): Promise<z.infer<typeof recordSchema>> {
      const id = commandIds.at(-1)
      assert.ok(id)
      return recordSchema.parse(
        JSON.parse(await readFile(join(registry, `copse-${id}.json`), 'utf8')),
      )
    }

    it('runs the argv in the requested checkout with HOME and TMPDIR inside the cell', async () => {
      const result = await cell.run({
        target: 'head',
        argv: [
          process.execPath,
          '-e',
          'console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, tmp: process.env.TMPDIR }))',
        ],
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      })
      assert.equal(result.exitCode, 0, result.output)
      assert.equal(result.timedOut, false)
      const probe = probeSchema.parse(JSON.parse(result.output.trim()))
      assert.equal(probe.cwd, spec.checkouts.head)
      assert.ok(probe.home.startsWith(scratch))
      assert.ok(probe.tmp.startsWith(scratch))
      assert.deepEqual(result.argv, [process.execPath, '-e', result.argv[2]])

      const record = await lastRecord()
      assert.equal(record.image, FAKE_IMAGE)
      assert.equal(Object.hasOwn(record.env, 'SECRET_TOKEN'), false)
      assert.equal(record.env['CI'], '1')
      assert.ok(record.flags.includes('--network=none'))
      assert.ok(record.flags.includes('dev.copse.runtime=' + (commandIds.at(-1) ?? '')))
      assert.ok(
        record.flags.includes(
          `--mount=type=bind,source=${join(scratch, 'store')},target=${join(scratch, 'store')},readonly`,
        ),
      )
    })

    it('reports a non-zero exit and the output tail without throwing', async () => {
      const result = await cell.run({
        target: 'base',
        argv: [
          process.execPath,
          '-e',
          'for (let i = 0; i < 500; i++) console.log("line " + i); console.error("boom"); process.exit(3)',
        ],
        timeoutMs: 30_000,
        maxOutputBytes: 256,
      })
      assert.equal(result.exitCode, 3)
      assert.equal(result.outputTruncated, true)
      assert.match(result.output, /boom/)
      assert.doesNotMatch(result.output, /line 0\n/)
      assert.equal((await lastRecord()).cwd, spec.checkouts.base)
    })

    it('ends a command that overruns its timeout through the engine and says so', async () => {
      const result = await cell.run({
        target: 'head',
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
        timeoutMs: 1_000,
        maxOutputBytes: 1024,
      })
      assert.equal(result.timedOut, true)
      assert.ok(result.durationMs < 10_000)
      // The fake reports a killed container the way an engine does.
      assert.equal(result.exitCode, 137)
    })

    it('rejects an aborted command and kills its container', async () => {
      const controller = new AbortController()
      const marker = join(scratch, 'abort-ready')
      const running = cell.run({
        target: 'head',
        argv: [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>{},60000)`,
        ],
        timeoutMs: 60_000,
        maxOutputBytes: 1024,
        signal: controller.signal,
      })
      const rejected = assert.rejects(running, /cancel review/)
      for (let i = 0; i < 500; i++) {
        if (
          await access(marker).then(
            () => true,
            () => false,
          )
        )
          break
        await delay(10)
      }
      controller.abort(new Error('cancel review'))
      await rejected
    })

    it('surfaces an engine that cannot run the image as a failed command', async () => {
      const other = await createContainerBackend({
        image: 'copse-review-fake:absent',
        engine: await writeFakeContainerEngine(registry),
      }).createCell(spec)
      try {
        const result = await other.run({
          target: 'head',
          argv: [process.execPath, '-e', 'process.exit(0)'],
          timeoutMs: 30_000,
          maxOutputBytes: 1024,
        })
        assert.equal(result.exitCode, 125)
        assert.match(result.output, /Unable to find image/)
      } finally {
        await other.destroy()
      }
    })

    it('keeps a command result when its container cannot be removed, and reports one that stays', async () => {
      // An engine too busy to remove a container (an Apple container VM under
      // memory pressure) must not cost the check that already finished.
      const engine = await writeFakeContainerEngine(registry)
      const cellFor = async (
        failures: number,
        unremoved: string[],
      ): Promise<{ cell: ExecutionCell; removals: () => number }> => {
        let removals = 0
        const cell = await createContainerBackend({
          image: FAKE_IMAGE,
          engine,
          containerName: (id) => `copse-busy-${id}`,
          onUnremoved: (name, reason, command) => {
            unremoved.push(`${name}|${reason}|${command}`)
          },
          spawn: (file, args, options) => {
            if (args.includes('rm') && removals++ < failures) {
              return spawn(
                process.execPath,
                [
                  '-e',
                  "process.stderr.write('Error: removal already in progress\\n'); process.exit(1)",
                ],
                options,
              )
            }
            return spawn(file, args, options)
          },
        }).createCell(spec)
        return { cell, removals: () => removals }
      }
      const command = {
        target: 'head' as const,
        argv: [process.execPath, '-e', "console.log('checked')"] as [string, ...string[]],
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
      }

      const retried: string[] = []
      const once = await cellFor(1, retried)
      const result = await once.cell.run(command)
      assert.equal(result.exitCode, 0)
      assert.match(result.output, /checked/)
      await once.cell.destroy()
      assert.equal(once.removals(), 2, 'retried once when the cell ended')
      assert.deepEqual(retried, [])

      const stuck: string[] = []
      const always = await cellFor(Infinity, stuck)
      assert.equal((await always.cell.run(command)).exitCode, 0)
      await always.cell.destroy()
      assert.equal(stuck.length, 1)
      assert.match(
        stuck[0] ?? '',
        /^copse-busy-\S+\|Error: removal already in progress\|.* rm --force copse-busy-/,
      )
    })

    for (const action of ['abort', 'destroy']) {
      it(`waits for container creation before cleanup on ${action}`, async () => {
        const slowRegistry = join(scratch, `slow-${action}`)
        await mkdir(slowRegistry)
        const other = await createContainerBackend({
          image: FAKE_IMAGE,
          engine: await writeFakeContainerEngine(slowRegistry, 500),
          containerName: () => 'delayed',
        }).createCell(spec)
        const controller = new AbortController()
        const marker = join(scratch, `must-not-run-${action}`)
        try {
          const running = other.run({
            target: 'head',
            argv: [
              process.execPath,
              '-e',
              `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
            ],
            signal: controller.signal,
            timeoutMs: 10_000,
            maxOutputBytes: 1024,
          })
          const rejected = assert.rejects(running, /cancel review|destroyed/)
          for (let i = 0; i < 500; i++) {
            if (
              await access(join(slowRegistry, 'delayed.creating')).then(
                () => true,
                () => false,
              )
            )
              break
            await delay(10)
          }
          await access(join(slowRegistry, 'delayed.creating'))
          if (action === 'abort') controller.abort(new Error('cancel review'))
          else await other.destroy()
          await rejected
          await access(join(slowRegistry, 'delayed.removed'))
          await assert.rejects(access(join(slowRegistry, 'delayed.active')), /ENOENT/)
          await assert.rejects(access(marker), /ENOENT/)
        } finally {
          await other.destroy()
        }
      })
    }
  })

  describe('detection', () => {
    let registry = ''
    before(async () => {
      registry = await mkdtemp(join(tmpdir(), 'review-container-detect-'))
    })
    after(async () => {
      await rm(registry, { recursive: true, force: true })
    })

    it('returns the backend when an engine holds the image', async () => {
      const engine = { argv: await writeFakeContainerEngine(registry), dialect: 'docker' as const }
      const detection = await detectContainerBackend({ image: FAKE_IMAGE, engines: [engine] })
      assert.equal(detection.reason, null)
      assert.equal(detection.backend.strength, 'container')
      assert.deepEqual(detection.engine, engine)
    })

    it('tries the next engine and keeps the dialect of the one that answers', async () => {
      const apple = { argv: await writeFakeContainerEngine(registry), dialect: 'apple' as const }
      const detection = await detectContainerBackend({
        image: FAKE_IMAGE,
        engines: [{ argv: ['copse-review-no-such-engine-binary'], dialect: 'docker' }, apple],
      })
      assert.equal(detection.reason, null)
      assert.deepEqual(detection.engine, apple)
    })

    it('says why when the image is missing or no engine answers', async () => {
      const engine = { argv: await writeFakeContainerEngine(registry), dialect: 'docker' as const }
      const missing = await detectContainerBackend({
        image: 'copse-review-fake:absent',
        engines: [engine],
      })
      assert.equal(missing.backend, null)
      assert.match(missing.reason, /No such image/)
      const none = await detectContainerBackend({
        image: FAKE_IMAGE,
        engines: [{ argv: ['copse-review-no-such-engine-binary'], dialect: 'docker' }],
      })
      assert.equal(none.backend, null)
      assert.match(none.reason, /not installed/)
    })

    it('reports an unknown engine preference instead of guessing', async () => {
      const previous = process.env['COPSE_CONTAINER_ENGINE']
      process.env['COPSE_CONTAINER_ENGINE'] = 'lxc'
      try {
        const detection = await detectContainerBackend({ image: FAKE_IMAGE })
        assert.equal(detection.backend, null)
        assert.match(detection.reason, /Unsupported COPSE_CONTAINER_ENGINE="lxc"/)
      } finally {
        if (previous === undefined) delete process.env['COPSE_CONTAINER_ENGINE']
        else process.env['COPSE_CONTAINER_ENGINE'] = previous
      }
    })
  })

  describe('engine choice', () => {
    const mac = { platform: 'darwin' as const, arch: 'arm64' }
    it('tries Docker, then Podman, then Apple container only on Apple silicon', () => {
      assert.deepEqual(defaultContainerEngines({ env: {}, ...mac }), [
        DOCKER_ENGINE,
        PODMAN_ENGINE,
        APPLE_CONTAINER_ENGINE,
      ])
      assert.deepEqual(defaultContainerEngines({ env: {}, platform: 'darwin', arch: 'x64' }), [
        DOCKER_ENGINE,
        PODMAN_ENGINE,
      ])
      assert.deepEqual(defaultContainerEngines({ env: {}, platform: 'linux', arch: 'arm64' }), [
        DOCKER_ENGINE,
        PODMAN_ENGINE,
      ])
    })

    it('tries only the engine COPSE_CONTAINER_ENGINE names', () => {
      for (const [value, engine] of [
        ['docker', DOCKER_ENGINE],
        ['Podman', PODMAN_ENGINE],
        [' apple ', APPLE_CONTAINER_ENGINE],
      ] as const) {
        assert.deepEqual(
          defaultContainerEngines({ env: { COPSE_CONTAINER_ENGINE: value }, ...mac }),
          [engine],
        )
      }
      assert.deepEqual(
        defaultContainerEngines({ env: { COPSE_CONTAINER_ENGINE: 'auto' }, ...mac }).length,
        3,
      )
      assert.throws(
        () => defaultContainerEngines({ env: { COPSE_CONTAINER_ENGINE: 'lxc' }, ...mac }),
        /Unsupported/,
      )
    })

    it('inspects an image in each dialect without a template Apple container does not take', () => {
      assert.deepEqual(imageInspectArgs('docker', 'img'), [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        'img',
      ])
      assert.deepEqual(imageInspectArgs('apple', 'img'), ['image', 'inspect', 'img'])
    })
  })

  describe('over the fake engine in Apple container dialect', () => {
    let scratch = ''
    let registry = ''
    let cell: ExecutionCell

    before(async () => {
      scratch = await realpath(await mkdtemp(join(tmpdir(), 'review-apple-backend-')))
      registry = join(scratch, 'registry')
      await mkdir(registry)
      await mkdir(join(scratch, 'base'))
      await mkdir(join(scratch, 'head'))
      cell = await createContainerBackend({
        image: FAKE_IMAGE,
        engine: await writeFakeContainerEngine(registry),
        dialect: 'apple',
        containerName: () => 'apple-cell',
      }).createCell({
        checkouts: { base: join(scratch, 'base'), head: join(scratch, 'head') },
        scratchDir: scratch,
        readOnlyPaths: [],
        env: cellEnvironment({ PATH: process.env['PATH'] }),
      })
    })

    after(async () => {
      await cell.destroy()
      await rm(scratch, { recursive: true, force: true })
    })

    it('runs the command under setpriv and deletes the container afterwards', async () => {
      const result = await cell.run({
        target: 'head',
        argv: [process.execPath, '-e', 'console.log(process.cwd())'],
        timeoutMs: 30_000,
        maxOutputBytes: 1024,
      })
      assert.equal(result.exitCode, 0, result.output)
      assert.equal(result.output.trim(), join(scratch, 'head'))
      const record = recordSchema.parse(
        JSON.parse(await readFile(join(registry, 'apple-cell.json'), 'utf8')),
      )
      assert.ok(record.flags.includes('--network') && record.flags.includes('none'))
      assert.deepEqual(record.argv, [process.execPath, '-e', 'console.log(process.cwd())'])
      await access(join(registry, 'apple-cell.removed'))
    })

    it('refuses to run in a cell whose walls do not read back, and runs nothing', async () => {
      // An engine that accepted --read-only and did not apply it.
      await writeFile(join(registry, 'inspect-override.json'), JSON.stringify({ readOnly: false }))
      const marker = join(scratch, 'ran-in-a-writable-cell')
      try {
        await assert.rejects(
          cell.run({
            target: 'head',
            argv: [
              process.execPath,
              '-e',
              `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
            ],
            timeoutMs: 30_000,
            maxOutputBytes: 1024,
          }),
          /Apple container did not create the review cell as asked \(the root filesystem is writable\)/,
        )
        await assert.rejects(access(marker), /ENOENT/)
        await access(join(registry, 'apple-cell.removed'))
      } finally {
        await rm(join(registry, 'inspect-override.json'), { force: true })
      }
    })

    it('reads back each mount and its access mode', () => {
      const input: ContainerRunInput = {
        name: 'apple-cell',
        image: FAKE_IMAGE,
        labels: {},
        user: { uid: 501, gid: 20 },
        limits: DEFAULT_CONTAINER_LIMITS,
        writable: ['/scratch/head'],
        readOnly: ['/store'],
        cwd: '/scratch/head',
        env: {},
        argv: ['true'],
      }
      const inspect = (mounts: unknown[]): string =>
        JSON.stringify([
          {
            configuration: {
              capAdd: [],
              capDrop: ['ALL'],
              readOnly: true,
              networks: [],
              useInit: true,
              ssh: false,
              virtualization: false,
              publishedPorts: [],
              publishedSockets: [],
              labels: {},
              resources: { cpus: 2, memoryInBytes: 4 * 1024 ** 3 },
              initProcess: {
                user: { raw: { userString: '501:20' } },
                rlimits: [{ limit: 'RLIMIT_NPROC', soft: 512, hard: 512 }],
              },
              mounts,
            },
          },
        ])
      const tmp = {
        destination: '/tmp',
        source: 'tmpfs',
        options: ['rw', 'nosuid', 'nodev'],
        type: { tmpfs: {} },
      }
      const head = {
        destination: '/scratch/head',
        source: '/scratch/head',
        options: [],
        type: { virtiofs: {} },
      }
      const store = (options: string[]): unknown => ({
        destination: '/store',
        source: '/store',
        options,
        type: { virtiofs: {} },
      })
      assert.equal(appleCellShortfall(input, inspect([tmp, head, store(['ro'])])), null)
      assert.equal(
        appleCellShortfall(input, inspect([tmp, head, store([])])),
        'the mount at /store is not the one asked for',
      )
      assert.equal(
        appleCellShortfall(input, inspect([tmp, head])),
        'the mount at /store is missing',
      )
      assert.equal(
        appleCellShortfall(
          input,
          inspect([tmp, head, store(['ro']), { ...head, destination: '/home' }]),
        ),
        'unexpected mount at /home',
      )
      assert.equal(
        appleCellShortfall(input, 'not json'),
        'container inspect did not describe the container',
      )
    })
  })
})
