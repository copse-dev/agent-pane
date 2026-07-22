import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

const makeAvailable = spawnSync('make', ['--version']).status === 0
const tempRoots: string[] = []

function makeFixture(npmScript: string): string {
  const root = mkdtempSync(join(tmpdir(), 'copse-make-deps-'))
  tempRoots.push(root)

  writeFileSync(join(root, 'Makefile'), readFileSync('Makefile'))
  writeFileSync(join(root, 'package.json'), '{}\n')
  writeFileSync(join(root, 'package-lock.json'), '{}\n')
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'npm'), npmScript)
  chmodSync(join(root, 'bin', 'npm'), 0o755)
  return root
}

function runDeps(root: string): SpawnSyncReturns<string> {
  return spawnSync('make', ['deps', `NVM_DIR=${join(root, 'missing-nvm')}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}` },
  })
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Makefile dependency install', { skip: !makeAvailable }, () => {
  it('removes a half-pruned tree and retries a retryable npm failure', () => {
    const root = makeFixture(`#!/usr/bin/env bash
set -eu
attempts=.npm-attempts
attempt=$(( $(cat "$attempts" 2>/dev/null || echo 0) + 1 ))
echo "$attempt" > "$attempts"
if [ "$attempt" -eq 1 ]; then
  echo 'npm error code ENOTEMPTY'
  exit 1
fi
if [ -e node_modules/stale-package ]; then
  echo 'stale node_modules survived cleanup' >&2
  exit 2
fi
mkdir -p node_modules/esbuild
echo '{}' > node_modules/esbuild/package.json
`)
    mkdirSync(join(root, 'node_modules', 'stale-package'), { recursive: true })

    const result = runDeps(root)

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(readFileSync(join(root, '.npm-attempts'), 'utf8'), '2\n')
    assert.equal(existsSync(join(root, 'node_modules', 'stale-package')), false)
    assert.equal(existsSync(join(root, 'node_modules', 'esbuild', 'package.json')), true)
    assert.equal(existsSync(join(root, '.tmp', 'deps.stamp')), true)
    assert.match(result.stdout, /wiping it and retrying/)
  })

  it('fails without writing the stamp when npm reports a non-retryable error', () => {
    const root = makeFixture(`#!/usr/bin/env bash
echo 'npm error code ECONNRESET'
exit 23
`)

    const result = runDeps(root)

    assert.notEqual(result.status, 0, result.stdout)
    assert.equal(existsSync(join(root, '.tmp', 'deps.stamp')), false)
  })

  it('fails without writing the stamp when the clean retry also fails', () => {
    const root = makeFixture(`#!/usr/bin/env bash
attempts=.npm-attempts
attempt=$(( $(cat "$attempts" 2>/dev/null || echo 0) + 1 ))
echo "$attempt" > "$attempts"
echo 'npm error code ENOTEMPTY'
exit 1
`)

    const result = runDeps(root)

    assert.notEqual(result.status, 0, result.stdout)
    assert.equal(readFileSync(join(root, '.npm-attempts'), 'utf8'), '2\n')
    assert.equal(existsSync(join(root, '.tmp', 'deps.stamp')), false)
  })

  it('repairs a stamped dependency tree when the build dependency is missing', () => {
    const root = makeFixture(`#!/usr/bin/env bash
echo ran > .npm-attempts
mkdir -p node_modules/esbuild
echo '{}' > node_modules/esbuild/package.json
`)
    mkdirSync(join(root, '.tmp'))
    const stamp = join(root, '.tmp', 'deps.stamp')
    writeFileSync(stamp, '')
    const future = new Date(Date.now() + 60_000)
    utimesSync(stamp, future, future)

    const result = runDeps(root)

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(readFileSync(join(root, '.npm-attempts'), 'utf8'), 'ran\n')
    assert.equal(existsSync(join(root, 'node_modules', 'esbuild', 'package.json')), true)
    assert.equal(existsSync(stamp), true)
  })
})
