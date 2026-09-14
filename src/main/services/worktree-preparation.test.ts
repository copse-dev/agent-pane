import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  inspectWorktreePreparation,
  preparationEnvironment,
  worktreePreparationShellEnvironment,
} from './worktree-preparation.ts'
import {
  packageInstallCommand,
  PREPARATION_CONFIG,
  PREPARATION_STAMP,
  readWorktreePreparationPlan,
} from './worktree-preparation-plan.ts'

const root = mkdtempSync(join(tmpdir(), 'project-preflight-'))
after(() => {
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root)
})
function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}
function project(manager: string, lock: string): void {
  write(
    'package.json',
    JSON.stringify({
      name: 'ordinary-project',
      packageManager: manager,
      dependencies: { example: '1.0.0' },
    }),
  )
  write(
    lock,
    lock === 'yarn.lock' && !manager.startsWith('yarn@1.')
      ? '__metadata:\n  version: 8'
      : 'fixture lock',
  )
}
function probe(command: string, args: readonly string[]): string | null {
  if (command === 'node') return '24.20.0\n137'
  if (command === 'npm') return '11.12.0'
  if (command === 'bun') return '1.4.2'
  if (command === 'corepack')
    return args[0]?.split('@')[1] ?? (args[0] === 'yarn' ? '1.22.22' : '10.34.5')
  return null
}
const inspect = (offline = false): ReturnType<typeof inspectWorktreePreparation> =>
  inspectWorktreePreparation(root, { probe, offline })

const managerCases: Array<[string, string, string]> = [
  ['npm@11.12.0', 'package-lock.json', 'ci'],
  ['pnpm@10.34.5', 'pnpm-lock.yaml', 'install'],
  ['yarn@1.22.22', 'yarn.lock', 'install'],
  ['yarn@2.4.3', 'yarn.lock', 'install'],
  ['yarn@3.8.7', 'yarn.lock', 'install'],
  ['yarn@4.9.2', 'yarn.lock', 'install'],
  ['bun@1.4.2', 'bun.lock', 'install'],
  ['bun@1.4.2', 'bun.lockb', 'install'],
]
for (const [manager, lock, verb] of managerCases) {
  it(`checks and fingerprints an unrelated ${manager} project`, async () => {
    project(manager, lock)
    const absent = await inspect()
    assert.equal(absent.state, 'absent')
    assert.equal(
      absent.components.some((component) => /Electron|gortex|ChromeDriver/.test(component.name)),
      false,
    )
    write('node_modules/example/package.json', '{"version":"1.0.0"}')
    const unstamped = await inspect()
    write(PREPARATION_STAMP, unstamped.expectedFingerprint)
    assert.equal((await inspect()).state, 'ready')
    assert.equal((await inspect(true)).state, 'ready')
    rmSync(join(root, 'node_modules/example'), { recursive: true })
    assert.equal((await inspect()).state, 'corrupt')
    write(lock, 'changed lock')
    assert.equal((await inspect()).state, 'stale')
    const command = packageInstallCommand(readWorktreePreparationPlan(root), true)
    assert.ok(command)
    assert.ok(command.args.includes(verb))
    assert.ok(
      command.args.includes('--ignore-scripts') ||
        command.args.includes('--mode=skip-build') ||
        command.args.includes('--skip-builds'),
    )
  })
}

describe('project detection and declared setup', () => {
  it('detects a single lockfile without name, scripts, packageManager, or a Node pin', async () => {
    write('package.json', '{}')
    write('package-lock.json', '{}')
    const report = await inspect()
    assert.equal(report.state, 'absent')
    assert.equal(report.components.find((component) => component.name === 'Node')?.ready, true)
    assert.equal(readWorktreePreparationPlan(root).manager?.name, 'npm')
  })
  it('reports configuration guidance for unknown ecosystems and missing lockfiles', async () => {
    write('pyproject.toml', '[project]\nname="demo"')
    assert.equal((await inspect()).state, 'needs-configuration')
    write('package.json', '{}')
    assert.match((await inspect()).remediation, /lockfile/)
  })
  it('rejects ambiguous lockfiles, and uses an explicit manager to disambiguate', async () => {
    project('npm@11.12.0', 'package-lock.json')
    write('yarn.lock', 'fixture')
    assert.equal(readWorktreePreparationPlan(root).manager?.name, 'npm')
    write('package.json', '{}')
    assert.match((await inspect()).remediation, /Conflicting lockfiles/)
  })
  it('rejects unsupported or non-exact manager pins without guessing', async () => {
    project('pnpm@latest', 'pnpm-lock.yaml')
    assert.equal((await inspect()).state, 'needs-configuration')
  })
  it('validates Node ranges and does not require Node for Bun-only projects', async () => {
    project('npm@11.12.0', 'package-lock.json')
    write('.nvmrc', '>=26')
    assert.equal(
      (await inspect()).components.find((component) => component.name === 'Node')?.ready,
      false,
    )
    write('.nvmrc', '24')
    assert.equal(
      (await inspect()).components.find((component) => component.name === 'Node')?.ready,
      true,
    )
    rmSync(join(root, '.nvmrc'))
    project('bun@1.4.2', 'bun.lock')
    const report = await inspectWorktreePreparation(root, {
      probe: (command, args) => (command === 'node' ? null : probe(command, args)),
    })
    assert.equal(
      report.components.some((component) => component.name === 'Node'),
      false,
    )
  })
  it('fingerprints manifests outside packages/, config, patches, and declared inputs', () => {
    project('npm@11.12.0', 'package-lock.json')
    write('package.json', JSON.stringify({ packageManager: 'npm@11.12.0', workspaces: ['apps/*'] }))
    const first = readWorktreePreparationPlan(root).fingerprint
    write('apps/web/package.json', '{}')
    assert.notEqual(readWorktreePreparationPlan(root).fingerprint, first)
    write(PREPARATION_CONFIG, JSON.stringify({ version: 1, inputs: ['setup.py'] }))
    const second = readWorktreePreparationPlan(root).fingerprint
    write('setup.py', 'print("setup")')
    assert.notEqual(readWorktreePreparationPlan(root).fingerprint, second)
  })
  it('supports any project with explicit setup and read-only checks, including an explicit no-op', async () => {
    write(
      PREPARATION_CONFIG,
      JSON.stringify({
        version: 1,
        inputs: ['requirements.txt'],
        prepare: [{ command: 'python3', args: ['-m', 'venv', '.venv'] }],
        checks: [{ name: 'Python environment', path: '.venv/bin/python' }],
      }),
    )
    const missing = await inspect()
    assert.equal(missing.state, 'absent')
    assert.match(missing.plan, /python3/)
    write('.venv/bin/python', 'fixture')
    const present = await inspect()
    write(PREPARATION_STAMP, present.expectedFingerprint)
    assert.equal((await inspect()).state, 'ready')
    write(PREPARATION_CONFIG, '{"version":1}')
    assert.equal((await inspect()).state, 'ready')
  })
  it('requires configuration/check paths to stay within the checkout', async () => {
    write(PREPARATION_CONFIG, JSON.stringify({ version: 1, inputs: ['../secret'] }))
    await assert.rejects(inspect(), /stay in the worktree/)
  })
  it('rejects symlinked host-read inputs', { skip: process.platform === 'win32' }, async () => {
    const outside = mkdtempSync(join(tmpdir(), 'preflight-outside-'))
    try {
      writeFileSync(join(outside, 'package.json'), '{}')
      symlinkSync(join(outside, 'package.json'), join(root, 'package.json'))
      await assert.rejects(inspect(), /outside the worktree/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('uses declared pnpm workspace patterns and ignores excluded/example projects', async () => {
    project('pnpm@10.34.5', 'pnpm-lock.yaml')
    write('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - '!apps/excluded'\n")
    write('apps/web/package.json', '{"dependencies":{"nested":"1.0.0"}}')
    write('apps/excluded/package.json', 'invalid ignored fixture')
    write('examples/standalone/package.json', 'invalid ignored fixture')
    const plan = readWorktreePreparationPlan(root)
    assert.deepEqual(plan.manifests, ['apps/web/package.json', 'package.json'])
    const report = await inspect()
    assert.match(
      report.components.find((component) => component.name === 'Dependencies')?.detail ?? '',
      /apps\/web/,
    )
    write('pnpm-workspace.yaml', 'packages: [broken')
    assert.equal((await inspect()).state, 'needs-configuration')
  })
  it('invalidates readiness for a declared runtime version probe', async () => {
    write(
      PREPARATION_CONFIG,
      JSON.stringify({
        version: 1,
        checks: [
          {
            name: 'Python',
            command: { command: 'python3', args: ['--version'] },
            fingerprintOutput: true,
          },
        ],
      }),
    )
    const before = await inspectWorktreePreparation(root, { probe: () => 'Python 3.13.0' })
    write(PREPARATION_STAMP, before.expectedFingerprint)
    assert.equal(
      (await inspectWorktreePreparation(root, { probe: () => 'Python 3.13.1' })).state,
      'stale',
    )
  })
  it(
    'fingerprints the contents of declared input symlinks inside the project',
    { skip: process.platform === 'win32' },
    () => {
      project('npm@11.12.0', 'package-lock.json')
      write('runtime-version', '24.20.0')
      symlinkSync('runtime-version', join(root, '.nvmrc'))
      const before = readWorktreePreparationPlan(root).fingerprint
      write('runtime-version', '24.21.0')
      assert.notEqual(readWorktreePreparationPlan(root).fingerprint, before)
    },
  )
  it('reports offline and malformed stamp states accurately', async () => {
    project('npm@11.12.0', 'package-lock.json')
    assert.equal((await inspect(true)).state, 'unavailable-offline')
    write(PREPARATION_STAMP, 'broken')
    assert.equal((await inspect()).state, 'corrupt')
  })
})

it('shares package caches with later shells without changing their install policy', () => {
  project('npm@11.12.0', 'package-lock.json')
  const shell = worktreePreparationShellEnvironment(root, {
    COPSE_DIR: '/profile',
    npm_config_ignore_scripts: 'false',
  })
  assert.equal(shell['npm_config_cache'], '/profile/cache/npm')
  assert.equal(shell['npm_config_ignore_scripts'], 'false')
  const env = preparationEnvironment({ COPSE_DIR: '/profile' })
  assert.equal(env['YARN_CACHE_FOLDER'], '/profile/cache/yarn')
  assert.equal(env['BUN_INSTALL_CACHE_DIR'], '/profile/cache/bun')
  assert.equal(env['npm_config_ignore_scripts'], 'true')
  assert.equal(env['YARN_ENABLE_SCRIPTS'], 'false')
})
