import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  containerCreateArgs,
  createContainerBackend,
  detectContainerBackend,
  DEFAULT_CONTAINER_LIMITS,
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
      const engine = await writeFakeContainerEngine(registry)
      const detection = await detectContainerBackend({ image: FAKE_IMAGE, engines: [engine] })
      assert.equal(detection.reason, null)
      assert.equal(detection.backend.strength, 'container')
      assert.deepEqual(detection.engine, engine)
    })

    it('says why when the image is missing or no engine answers', async () => {
      const engine = await writeFakeContainerEngine(registry)
      const missing = await detectContainerBackend({
        image: 'copse-review-fake:absent',
        engines: [engine],
      })
      assert.equal(missing.backend, null)
      assert.match(missing.reason, /No such image/)
      const none = await detectContainerBackend({
        image: FAKE_IMAGE,
        engines: [['copse-review-no-such-engine-binary']],
      })
      assert.equal(none.backend, null)
      assert.match(none.reason, /not installed/)
    })
  })
})
