import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEV_STATE,
  NATIVE_PREPARATION_INPUTS,
  dependencyFingerprint,
  writeFingerprint,
  type DependencyContextFingerprint,
} from '../../../scripts/lib/dev-sync.mts'
import { NATIVE_PREPARATION_SCRIPT } from '../../../scripts/lib/native-artifacts.mts'
import {
  inspectWorktreePreparation,
  preparationEnvironment,
  worktreePreparationShellEnvironment,
  type WorktreePreparationReport,
} from './worktree-preparation.ts'

const root = mkdtempSync(join(tmpdir(), 'copse-worktree-preparation-'))
const runtime: DependencyContextFingerprint = {
  node: '24.20.0',
  nodeModulesAbi: '137',
  platform: process.platform,
  arch: process.arch,
}

after(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  seedRepositoryInputs()
})

function write(path: string, value: string, executable = false): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, value)
  if (executable && process.platform !== 'win32') chmodSync(absolute, 0o755)
}

function seedRepositoryInputs(): void {
  write(
    'package.json',
    JSON.stringify({
      name: 'copse-panel',
      packageManager: 'pnpm@10.34.5',
      scripts: { 'prepare:native': NATIVE_PREPARATION_SCRIPT },
    }),
  )
  write('.nvmrc', 'v24.20.0\n')
  write('.npmrc', 'ignore-scripts=false\n')
  write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  write('pnpm-workspace.yaml', 'packages: []\n')
  for (const path of NATIVE_PREPARATION_INPUTS) {
    if (path === 'scripts/prepare-native-artifacts.mts') continue
    write(path, `fixture:${path}\n`)
  }
  write('scripts/prepare-native-artifacts.mts', 'fixture:native-preparation\n')
}

function seedReadyArtifacts(): void {
  write('node_modules/.modules.yaml', 'ready\n')
  write('node_modules/esbuild/package.json', '{"version":"1.0.0"}\n')
  write('node_modules/electron/package.json', '{"version":"44.0.0"}\n')
  write('node_modules/electron/dist/version', 'v44.0.0\n')
  write('node_modules/electron/path.txt', 'electron\n')
  write('node_modules/electron/dist/electron', 'electron fixture\n', true)
  write('node_modules/electron-chromedriver/package.json', '{"version":"44.0.0"}\n')
  write(
    `node_modules/electron-chromedriver/bin/${
      process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver'
    }`,
    'driver fixture\n',
    true,
  )
  write(
    `vendor/gortex/${process.platform === 'win32' ? 'gortex.exe' : 'gortex'}`,
    'gortex fixture\n',
    true,
  )
}

function probe(command: string, args: readonly string[]): string | null {
  if (command === 'node') return '24.20.0\n137'
  if (command === 'corepack' && args.join(' ') === 'pnpm --version') return '10.34.5'
  if (command.includes('chromedriver')) return 'ChromeDriver 44.0.0'
  if (command.endsWith('gortex') || command.endsWith('gortex.exe')) return 'gortex 0.60.0'
  return null
}

function inspect(offline = false): WorktreePreparationReport {
  return inspectWorktreePreparation(root, {
    dependencyContext: runtime,
    offline,
    probe: (command, args) => probe(command, args),
  })
}

function recordCurrentFingerprint(): void {
  writeFingerprint(root, DEV_STATE.dependencies, dependencyFingerprint(root, runtime))
}

describe('inspectWorktreePreparation', () => {
  it('reports an absent fresh worktree with focused remediation', () => {
    const report = inspect()

    assert.equal(report.state, 'absent')
    assert.equal(report.components.dependencies.ready, false)
    assert.match(report.remediation, /prepare_worktree/)
  })

  it('accepts a present, matching prepared worktree', () => {
    seedReadyArtifacts()
    recordCurrentFingerprint()

    const report = inspect()

    assert.equal(report.state, 'ready')
    assert.equal(report.components.node.ready, true)
    assert.equal(report.components.pnpm.ready, true)
    assert.equal(report.components.electron.ready, true)
    assert.equal(report.components.chromedriver.ready, true)
    assert.equal(report.components.gortex.ready, true)
  })

  it('reports stale when a fingerprinted repository input changes', () => {
    seedReadyArtifacts()
    recordCurrentFingerprint()
    write('pnpm-lock.yaml', "lockfileVersion: '9.1'\n")

    assert.equal(inspect().state, 'stale')
  })

  it('reports corrupt for a malformed fingerprint', () => {
    seedReadyArtifacts()
    write(DEV_STATE.dependencies, 'not-a-fingerprint\n')

    assert.equal(inspect().state, 'corrupt')
  })

  it('reports corrupt when a recorded preparation loses a native artifact', () => {
    seedReadyArtifacts()
    recordCurrentFingerprint()
    unlinkSync(
      join(
        root,
        'node_modules',
        'electron-chromedriver',
        'bin',
        process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver',
      ),
    )

    const report = inspect()
    assert.equal(report.state, 'corrupt')
    assert.equal(report.components.chromedriver.ready, false)
  })

  it('reports unavailable-offline when matching prepared inputs are absent', () => {
    const report = inspect(true)

    assert.equal(report.state, 'unavailable-offline')
    assert.match(report.remediation, /Reconnect|restore/)
  })

  it('invalidates when Node, package-manager, or native preparation inputs change', () => {
    const initial = dependencyFingerprint(root, runtime)

    assert.notEqual(dependencyFingerprint(root, { ...runtime, node: '24.21.0' }), initial)

    write(
      'package.json',
      JSON.stringify({
        name: 'copse-panel',
        packageManager: 'pnpm@10.35.0',
        scripts: { 'prepare:native': NATIVE_PREPARATION_SCRIPT },
      }),
    )
    assert.notEqual(dependencyFingerprint(root, runtime), initial)

    seedRepositoryInputs()
    write('scripts/lib/native-artifacts.mts', 'changed native version constants\n')
    assert.notEqual(dependencyFingerprint(root, runtime), initial)

    seedRepositoryInputs()
    write('scripts/check-node-version.cjs', 'changed Node validation\n')
    assert.notEqual(dependencyFingerprint(root, runtime), initial)
  })
})

describe('preparationEnvironment', () => {
  it('routes every external preparation cache under COPSE_DIR', () => {
    const env = preparationEnvironment({
      COPSE_DIR: '/profiles/copse',
      PATH: '/usr/bin',
    })

    assert.equal(env['COREPACK_HOME'], '/profiles/copse/cache/corepack')
    assert.equal(env['npm_config_store_dir'], '/profiles/copse/cache/pnpm-store')
    assert.equal(env['electron_config_cache'], '/profiles/copse/cache/electron-downloads')
    assert.equal(env['COPSE_ELECTRON_DIST_CACHE'], '/profiles/copse/cache/electron-dist')
    assert.equal(env['COPSE_GORTEX_CACHE'], '/profiles/copse/cache/gortex')
    assert.equal(env['CI'], 'true')
    assert.equal(env['npm_config_ignore_scripts'], 'true')
  })

  it('routes later shell commands through the same caches without changing install policy', () => {
    const env = worktreePreparationShellEnvironment(root, {
      COPSE_DIR: '/profiles/copse',
      PATH: '/usr/bin',
      npm_config_ignore_scripts: 'false',
    })

    assert.equal(env['COREPACK_HOME'], '/profiles/copse/cache/corepack')
    assert.equal(env['npm_config_store_dir'], '/profiles/copse/cache/pnpm-store')
    assert.equal(env['npm_config_ignore_scripts'], 'false')
  })

  it('leaves unrelated project shell environments unchanged', () => {
    const unrelated = mkdtempSync(join(tmpdir(), 'unrelated-worktree-'))
    try {
      writeFileSync(join(unrelated, 'package.json'), '{"name":"another-project"}')
      const env = { PATH: '/usr/bin' }

      assert.equal(worktreePreparationShellEnvironment(unrelated, env), env)
    } finally {
      rmSync(unrelated, { recursive: true, force: true })
    }
  })
})
