import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { BUILD_SENTINELS, DEV_STATE } from './lib/dev-sync.mts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Real Make/Node orchestration, with only package installation and app launch replaced. */
function fixture(): {
  root: string
  run: (preload?: string) => SpawnSyncReturns<string>
  calls: () => string[]
} {
  const root = mkdtempSync(join(tmpdir(), 'copse-make-run-'))
  roots.push(root)
  for (const path of ['Makefile', 'scripts/sync-dev.mts', 'scripts/lib/dev-sync.mts']) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    copyFileSync(path, join(root, path))
  }
  writeFileSync(join(root, 'package.json'), '{"name":"launcher-fixture"}')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  writeFileSync(join(bin, 'corepack'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')
const args = process.argv.slice(2).join(' ')
appendFileSync('calls', args + '\\n')
function write(path) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'fixture output')
}
if (args === 'install --frozen-lockfile') {
  if (process.env.npm_config_ignore_scripts !== 'false') process.exit(21)
  if (existsSync('fail-install')) process.exit(23)
  write('node_modules/.modules.yaml')
  write('node_modules/esbuild/package.json')
} else if (args === 'run build') {
  if (existsSync('fail-build')) process.exit(24)
  for (const path of ${JSON.stringify(BUILD_SENTINELS)}) write(path)
} else if (args !== 'start') {
  process.exit(25)
}
`,
    { mode: 0o755 },
  )
  return {
    root,
    run: (preload) =>
      spawnSync('make', ['run'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: [bin, process.env['PATH'] ?? ''].join(delimiter),
          COPSE_PRESERVE_PATH: '1',
          npm_config_ignore_scripts: 'true',
          NODE_OPTIONS: preload ? `--require ${JSON.stringify(preload)}` : '',
        },
      }),
    calls: () =>
      existsSync(join(root, 'calls'))
        ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')
        : [],
  }
}

describe('make run recovery', () => {
  it('installs and builds once, then reuses successful state', () => {
    const prepared = fixture()
    const first = prepared.run()
    assert.equal(first.status, 0, first.stdout + first.stderr)
    const second = prepared.run()
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.deepEqual(prepared.calls(), ['install --frozen-lockfile', 'run build', 'start', 'start'])
  })

  it('does not stamp, build, or launch after an install failure, and retries successfully', () => {
    const prepared = fixture()
    const failure = join(prepared.root, 'fail-install')
    writeFileSync(failure, '')
    const failed = prepared.run()
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /failed \(23\)/)
    assert.deepEqual(prepared.calls(), ['install --frozen-lockfile'])
    for (const state of Object.values(DEV_STATE)) {
      assert.equal(existsSync(join(prepared.root, state)), false, state)
    }
    rmSync(failure)
    const retried = prepared.run()
    assert.equal(retried.status, 0, retried.stdout + retried.stderr)
    assert.deepEqual(prepared.calls(), [
      'install --frozen-lockfile',
      'install --frozen-lockfile',
      'run build',
      'start',
    ])
  })

  it('does not stamp or launch a failed build, and retries without reinstalling', () => {
    const prepared = fixture()
    const failure = join(prepared.root, 'fail-build')
    writeFileSync(failure, '')
    const failed = prepared.run()
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /failed \(24\)/)
    assert.equal(existsSync(join(prepared.root, DEV_STATE.dependencies)), true)
    for (const state of [DEV_STATE.build, DEV_STATE.buildOutputs, DEV_STATE.distMarker]) {
      assert.equal(existsSync(join(prepared.root, state)), false, state)
    }
    rmSync(failure)
    const retried = prepared.run()
    assert.equal(retried.status, 0, retried.stdout + retried.stderr)
    assert.deepEqual(prepared.calls(), [
      'install --frozen-lockfile',
      'run build',
      'run build',
      'start',
    ])
  })

  it('continues past undeletable old dependencies and sweeps them on a later install', () => {
    const prepared = fixture()
    const old = join(prepared.root, '.tmp/node_modules-old.123')
    const removable = join(prepared.root, '.tmp/node_modules-old.456')
    mkdirSync(old, { recursive: true })
    mkdirSync(removable)
    writeFileSync(join(old, 'leftover'), 'old dependency')
    // Inject the reported macOS filesystem race at the filesystem boundary.
    // Permission bits alone cannot reproduce it in CI containers running as root.
    const preload = join(prepared.root, 'cleanup-failure.cjs')
    writeFileSync(
      preload,
      `const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const original = fs.rmSync
fs.rmSync = function(path, options) {
  if (String(path).endsWith('/node_modules-old.123')) {
    throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' })
  }
  return original(path, options)
}
syncBuiltinESMExports()
`,
    )
    const first = prepared.run(preload)
    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.match(first.stderr, /node_modules-old\.123.*survived deletion/)
    assert.equal(existsSync(join(old, 'leftover')), true)
    assert.equal(existsSync(removable), false)
    assert.deepEqual(prepared.calls(), ['install --frozen-lockfile', 'run build', 'start'])

    rmSync(join(prepared.root, DEV_STATE.dependencies))
    const recovered = prepared.run()
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr)
    assert.equal(existsSync(old), false)
  })
})
