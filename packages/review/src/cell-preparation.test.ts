import { execFileSync, spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { z } from 'zod'
import {
  cellImageBuildArgs,
  cellPlatform,
  imageArchitecture,
  pnpmSeedWorkspace,
  primeDependencyCache,
  trustedPreparationScript,
} from './cell-preparation.ts'
import { pnpmLockPatches } from './dependency-policy.ts'

const integrity = 'sha512-YQ=='
const resolved = 'https://registry.npmjs.org/example/-/example-1.0.0.tgz'

const workspaceSchema = z.object({
  packages: z.array(z.string()),
  patchedDependencies: z.record(z.string(), z.string()),
  supportedArchitectures: z.object({
    os: z.array(z.string()),
    cpu: z.array(z.string()),
    libc: z.array(z.string()),
  }),
})

function pnpmLock(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    lockfileVersion: '9.0',
    packages: { 'example@1.0.0': { resolution: { integrity } } },
    ...extra,
  })
}

/** A lockfile with no packages: pnpm fetches nothing, so the test needs no network. */
const EMPTY_PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`

/** The pnpm the reviewer pins, which Corepack already holds wherever its tests run. */
const reviewerPackageManager = z
  .object({ packageManager: z.string() })
  .parse(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../../package.json'), 'utf8')),
  ).packageManager

const pnpmMissing = spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status !== 0

interface Call {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>> | undefined
}

async function withSeed(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'review-cell-preparation-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('cell preparation', () => {
  it('fetches pnpm packages for the cell platform, not the host', async () => {
    await withSeed(async (root) => {
      const seed = join(root, 'seed')
      const calls: Call[] = []
      const patch = 'patches/example@1.0.0.patch'
      const lock = pnpmLock({
        patchedDependencies: { 'example@1.0.0': { hash: 'a'.repeat(64), path: patch } },
      })
      const files: Record<string, string> = { 'pnpm-lock.yaml': lock, [patch]: 'diff --git\n' }
      // A leftover virtual store from an earlier fetch must not reach the next one.
      await mkdir(join(seed, 'node_modules'), { recursive: true })
      await primeDependencyCache({
        profile: 'pnpm',
        revisions: ['base', 'head'],
        show: (revision, path) => {
          const text = files[path]
          if (text === undefined) throw new Error(`${revision}:${path} missing`)
          return text
        },
        seed,
        cache: join(root, 'store'),
        platform: cellPlatform('arm64'),
        packageManager: 'pnpm@10.34.5',
        run: (file, args, options) => {
          calls.push({ file, args, cwd: options.cwd, env: options.env })
        },
      })
      assert.equal(calls.length, 2)
      for (const call of calls) {
        assert.equal(call.file, 'pnpm')
        assert.equal(call.cwd, seed)
        assert.deepEqual(call.args.slice(0, 4), [
          'fetch',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--ignore-pnpmfile',
        ])
        assert.equal(call.args[call.args.indexOf('--store-dir') + 1], join(root, 'store'))
        // The caller's own config (and its tokens) never reaches the fetch:
        // empty npm config files, and an empty directory for pnpm's global rc.
        // `pnpm fetch` refuses these as flags.
        assert.ok(!call.args.includes('--userconfig') && !call.args.includes('--globalconfig'))
        const env = call.env ?? {}
        for (const key of [
          'npm_config_userconfig',
          'npm_config_globalconfig',
          'NPM_CONFIG_USERCONFIG',
          'NPM_CONFIG_GLOBALCONFIG',
        ]) {
          const config = env[key]
          assert.ok(config !== undefined, key)
          assert.equal(await readFile(config, 'utf8'), '')
        }
        const configHome = env['XDG_CONFIG_HOME']
        assert.ok(configHome !== undefined)
        assert.deepEqual(await readdir(configHome), [])
      }
      const workspace = workspaceSchema.parse(
        loadYaml(await readFile(join(seed, 'pnpm-workspace.yaml'), 'utf8')),
      )
      assert.deepEqual(workspace.supportedArchitectures, {
        os: ['linux'],
        cpu: ['arm64'],
        libc: ['glibc'],
      })
      assert.deepEqual(workspace.patchedDependencies, { 'example@1.0.0': patch })
      assert.equal(await readFile(join(seed, patch), 'utf8'), 'diff --git\n')
      assert.equal(await readFile(join(seed, 'pnpm-lock.yaml'), 'utf8'), `${lock}\n`)
      assert.deepEqual(JSON.parse(await readFile(join(seed, 'package.json'), 'utf8')), {
        private: true,
        packageManager: 'pnpm@10.34.5',
      })
      await assert.rejects(access(join(seed, 'node_modules')), /ENOENT/)
    })
  })

  it(
    'runs a fetch real pnpm accepts, and none of the caller’s config reaches it',
    { skip: pnpmMissing ? 'pnpm is not on PATH' : false },
    async () => {
      await withSeed(async (root) => {
        // The caller's config: a scoped registry in their npm config and in
        // pnpm's own global rc.
        const callerNpmrc = join(root, 'caller.npmrc')
        const callerConfigHome = join(root, 'caller-config')
        await writeFile(callerNpmrc, '@caller-npmrc:registry=http://127.0.0.1:9/\n')
        await mkdir(join(callerConfigHome, 'pnpm'), { recursive: true })
        await writeFile(
          join(callerConfigHome, 'pnpm', 'rc'),
          '@caller-rc:registry=http://127.0.0.1:9/\n',
        )
        // Under both spellings, as a caller may set either; this host's own
        // values of them are dropped so the fixture is what pnpm reads.
        const callerEnv: NodeJS.ProcessEnv = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !/^npm_config_(user|global)config$/i.test(key),
            ),
          ),
          npm_config_userconfig: callerNpmrc,
          NPM_CONFIG_USERCONFIG: callerNpmrc,
          XDG_CONFIG_HOME: callerConfigHome,
        }
        const seed = join(root, 'seed')
        const scopes = (env: NodeJS.ProcessEnv): string[] =>
          ['@caller-npmrc:registry', '@caller-rc:registry'].map((key) =>
            execFileSync('pnpm', ['config', 'get', key], {
              cwd: seed,
              env,
              encoding: 'utf8',
            }).trim(),
          )
        const fetchEnvs: NodeJS.ProcessEnv[] = []
        await primeDependencyCache({
          profile: 'pnpm',
          revisions: ['head'],
          show: () => EMPTY_PNPM_LOCK,
          seed,
          cache: join(root, 'store'),
          platform: cellPlatform('arm64'),
          packageManager: reviewerPackageManager,
          run: (file, args, options) => {
            const env = { ...callerEnv, ...options.env }
            fetchEnvs.push(env)
            // Throws on a non-zero exit, as for an option pnpm does not take.
            execFileSync(file, [...args], { cwd: options.cwd, env, stdio: 'pipe' })
          },
        })
        const [fetchEnv] = fetchEnvs
        assert.ok(fetchEnv !== undefined && fetchEnvs.length === 1)
        // The fixture is read where nothing overrides it, so the check below means something.
        assert.deepEqual(scopes(callerEnv), ['http://127.0.0.1:9/', 'http://127.0.0.1:9/'])
        assert.deepEqual(scopes(fetchEnv), ['undefined', 'undefined'])
      })
    },
  )

  it('adds each npm registry tarball once across revisions with an empty config', async () => {
    await withSeed(async (root) => {
      const seed = join(root, 'seed')
      const calls: Call[] = []
      const lock = JSON.stringify({
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/example': { resolved, integrity } },
      })
      await primeDependencyCache({
        profile: 'npm',
        revisions: ['base', 'head'],
        show: () => lock,
        seed,
        cache: join(root, 'npm-cache'),
        platform: cellPlatform('x64'),
        run: (file, args, options) => {
          calls.push({ file, args, cwd: options.cwd, env: options.env })
        },
      })
      assert.deepEqual(
        calls.map((call) => [call.file, call.args[2]]),
        [['npm', resolved]],
      )
      const args = calls[0]?.args ?? []
      assert.equal(args[args.indexOf('--userconfig') + 1], join(seed, 'empty.npmrc'))
      assert.equal(await readFile(join(seed, 'empty.npmrc'), 'utf8'), '')
      await access(join(root, 'npm-cache', '_cacache'))
    })
  })

  it('refuses a lockfile the host must not fetch from before running anything', async () => {
    await withSeed(async (root) => {
      let ran = false
      await assert.rejects(
        primeDependencyCache({
          profile: 'copse-pnpm',
          revisions: ['head'],
          show: () =>
            JSON.stringify({
              lockfileVersion: '9.0',
              packages: {
                'local@file:packages/local': {
                  resolution: { directory: 'packages/local', type: 'directory' },
                },
              },
            }),
          seed: join(root, 'seed'),
          cache: join(root, 'store'),
          platform: cellPlatform('arm64'),
          run: () => {
            ran = true
          },
        }),
        /extract-zip/,
      )
      assert.equal(ran, false)
    })
  })

  it('names the platform and image architecture of the cell', () => {
    assert.deepEqual(cellPlatform('arm64'), { os: 'linux', cpu: 'arm64', libc: 'glibc' })
    assert.throws(() => cellPlatform('ia32'), /arm64 or x64/)
    assert.equal(imageArchitecture('x64'), 'amd64')
    assert.equal(imageArchitecture('arm64'), 'arm64')
    assert.match(pnpmSeedWorkspace({}, cellPlatform('x64')), /"cpu":\["x64"\]/)
  })

  it('builds the image in each engine dialect, with a CA secret only under Docker', () => {
    assert.deepEqual(
      cellImageBuildArgs({
        dialect: 'docker',
        dockerfile: '/r/Dockerfile.cell',
        tag: 'cell:1',
        context: '/ctx',
        proxyCaFile: '/ca.pem',
      }),
      [
        'build',
        '--secret',
        'id=proxy_ca,src=/ca.pem',
        '--file',
        '/r/Dockerfile.cell',
        '--tag',
        'cell:1',
        '/ctx',
      ],
    )
    assert.deepEqual(
      cellImageBuildArgs({
        dialect: 'apple',
        dockerfile: '/r/Dockerfile.cell',
        tag: 'cell:1',
        context: '/ctx',
        cpu: 'arm64',
      }),
      ['build', '--file', '/r/Dockerfile.cell', '--tag', 'cell:1', '--arch', 'arm64', '/ctx'],
    )
    assert.ok(
      cellImageBuildArgs({
        dialect: 'docker',
        dockerfile: 'f',
        tag: 't',
        context: 'c',
        cpu: 'x64',
      }).includes('linux/amd64'),
    )
    assert.throws(() =>
      cellImageBuildArgs({
        dialect: 'apple',
        dockerfile: 'f',
        tag: 't',
        context: 'c',
        proxyCaFile: '/ca.pem',
      }),
    )
  })

  it('takes trusted preparation from the reviewer checkout, never the change', async () => {
    for (const profile of ['npm', 'copse-pnpm'] as const) {
      const script = trustedPreparationScript(profile)
      assert.ok(script !== null)
      await access(script)
    }
    assert.equal(trustedPreparationScript('pnpm'), null)
  })
})

describe('pnpm lockfile policy', () => {
  it('admits relative directory dependencies only under the portable profile', () => {
    const directory = (path: string): string =>
      JSON.stringify({
        lockfileVersion: '9.0',
        packages: { 'local@file:x': { resolution: { directory: path, type: 'directory' } } },
      })
    assert.deepEqual(pnpmLockPatches(directory('packages/local'), 'relative'), {})
    for (const path of ['/etc', '../outside', 'packages/../../x', 'C:/x', 'a\\b', 'a//b']) {
      assert.throws(() => pnpmLockPatches(directory(path), 'relative'), /inside the repository/)
    }
    assert.throws(() => pnpmLockPatches(directory('packages/local'), 'copse'), /extract-zip/)
  })

  it('accepts a lockfile with no packages', () => {
    assert.deepEqual(pnpmLockPatches(JSON.stringify({ lockfileVersion: '9.0' }), 'relative'), {})
  })
})
