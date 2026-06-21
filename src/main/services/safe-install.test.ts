import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteInstallCommand } from './safe-install.ts'

const NO_LOCKFILES = { lockfiles: new Set<string>() }
const NPM_LOCK = { lockfiles: new Set(['package-lock.json']) }
const PNPM_LOCK = { lockfiles: new Set(['pnpm-lock.yaml']) }

describe('rewriteInstallCommand', () => {
  it('wraps npm install with sfw and --ignore-scripts', () => {
    const plan = rewriteInstallCommand('npm install lodash', NO_LOCKFILES)
    assert.equal(plan.isInstall, true)
    assert.equal(plan.command, 'sfw npm install lodash --ignore-scripts')
  })

  it('prefers npm ci for a bare install when a lockfile is present', () => {
    const plan = rewriteInstallCommand('npm install', NPM_LOCK)
    assert.equal(plan.command, 'sfw npm ci --ignore-scripts')
    assert.ok(plan.notes.some((n) => n.includes('npm ci')))
  })

  it('does not switch to npm ci when installing specific packages', () => {
    const plan = rewriteInstallCommand('npm install lodash', NPM_LOCK)
    assert.equal(plan.command, 'sfw npm install lodash --ignore-scripts')
  })

  it('does not switch to npm ci without a lockfile', () => {
    const plan = rewriteInstallCommand('npm install', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw npm install --ignore-scripts')
  })

  it('treats npm i as install', () => {
    const plan = rewriteInstallCommand('npm i', NPM_LOCK)
    assert.equal(plan.command, 'sfw npm ci --ignore-scripts')
  })

  it('leaves non-install npm commands untouched', () => {
    for (const cmd of ['npm test', 'npm run build', 'npm test -- --coverage']) {
      const plan = rewriteInstallCommand(cmd, NPM_LOCK)
      assert.equal(plan.isInstall, false)
      assert.equal(plan.command, cmd)
    }
  })

  it('wraps yarn add', () => {
    const plan = rewriteInstallCommand('yarn add react', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw yarn add react --ignore-scripts')
  })

  it('wraps a bare yarn (defaults to install)', () => {
    const plan = rewriteInstallCommand('yarn', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw yarn --ignore-scripts')
  })

  it('pins pnpm install to the lockfile via --frozen-lockfile', () => {
    const plan = rewriteInstallCommand('pnpm install', PNPM_LOCK)
    assert.equal(plan.command, 'sfw pnpm install --frozen-lockfile --ignore-scripts')
  })

  it('wraps pip install without --ignore-scripts', () => {
    const plan = rewriteInstallCommand('pip install requests', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw pip install requests')
  })

  it('wraps python -m pip install', () => {
    const plan = rewriteInstallCommand('python3 -m pip install requests', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw python3 -m pip install requests')
  })

  it('wraps uv pip install and uv add', () => {
    assert.equal(
      rewriteInstallCommand('uv pip install ruff', NO_LOCKFILES).command,
      'sfw uv pip install ruff',
    )
    assert.equal(rewriteInstallCommand('uv add ruff', NO_LOCKFILES).command, 'sfw uv add ruff')
  })

  it('wraps cargo install', () => {
    const plan = rewriteInstallCommand('cargo install ripgrep', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw cargo install ripgrep')
  })

  it('wraps npx without script/lockfile flags', () => {
    const plan = rewriteInstallCommand('npx cowsay hi', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw npx cowsay hi')
  })

  it('only rewrites the install segment of a compound command', () => {
    const plan = rewriteInstallCommand('npm install lodash && npm test', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw npm install lodash --ignore-scripts && npm test')
  })

  it('preserves leading env assignments and sudo in front of sfw', () => {
    assert.equal(
      rewriteInstallCommand('CI=1 npm install', NO_LOCKFILES).command,
      'CI=1 sfw npm install --ignore-scripts',
    )
    assert.equal(
      rewriteInstallCommand('sudo npm install -g typescript', NO_LOCKFILES).command,
      'sudo sfw npm install -g typescript --ignore-scripts',
    )
  })

  it('does not double-wrap an already sfw-wrapped command', () => {
    const cmd = 'sfw npm install lodash --ignore-scripts'
    const plan = rewriteInstallCommand(cmd, NO_LOCKFILES)
    assert.equal(plan.isInstall, false)
    assert.equal(plan.command, cmd)
  })

  it('does not duplicate an existing --ignore-scripts flag', () => {
    const plan = rewriteInstallCommand('npm install lodash --ignore-scripts', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw npm install lodash --ignore-scripts')
  })

  it('wraps but does not append flags behind a redirection', () => {
    const plan = rewriteInstallCommand('npm install > out.log', NO_LOCKFILES)
    assert.equal(plan.command, 'sfw npm install > out.log')
  })

  it('returns isInstall=false for ordinary commands', () => {
    const plan = rewriteInstallCommand('ls -la && git status', NPM_LOCK)
    assert.equal(plan.isInstall, false)
    assert.equal(plan.command, 'ls -la && git status')
  })
})
