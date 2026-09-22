import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PREPARATION_CONFIG,
  PREPARATION_STAMP,
  formatPreparationApproval,
  readWorktreePreparationPlan,
} from './worktree-preparation-plan.ts'
import { inspectWorktreePreparation } from './worktree-preparation.ts'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'go-preflight-')))
  write('go.mod', 'module example.test/app\n\ngo 1.24\n\nrequire example.test/dep v1.0.0\n')
  write('go.sum', 'example.test/dep v1.0.0 h1:fixture\n')
  write('main.go', 'package main\nimport _ "example.test/dep"\nfunc main() {}\n')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(path: string, text: string): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

it('detects Go modules and describes readonly package loading accurately', () => {
  const plan = readWorktreePreparationPlan(root)
  assert.equal(plan.ecosystem, 'go')
  assert.deepEqual(plan.problems, [])
  assert.deepEqual(plan.prepare, [
    { command: 'go', args: ['list', '-mod=readonly', '-deps', '-test', 'all'] },
  ])
  assert.deepEqual(
    plan.checks.map(({ name, command }) => ({ name, command })),
    [
      { name: 'Go toolchain', command: { command: 'go', args: ['version'] } },
      {
        name: 'Readonly Go package graph',
        command: { command: 'go', args: ['list', '-mod=readonly', '-deps', '-test', 'all'] },
      },
      {
        name: 'Verified Go module cache',
        command: { command: 'go', args: ['mod', 'verify'] },
      },
    ],
  )
  const approval = formatPreparationApproval(plan, false)
  assert.match(approval.body, /'go' 'list' '-mod=readonly'/)
  assert.match(approval.bodyAdvice, /package and test import metadata/)
  assert.match(approval.bodyAdvice, /does not run go generate, build, or test/)
  assert.match(approval.bodyFooter, /project remains read-only/)
})

it('requires declarations for mixed ecosystems and lets a declaration take precedence', () => {
  write('package.json', '{"packageManager":"npm@11.0.0"}')
  write('package-lock.json', '{}')
  assert.match(readWorktreePreparationPlan(root).problems.join(' '), /Multiple ecosystems/)
  write(PREPARATION_CONFIG, '{"version":1}')
  const explicit = readWorktreePreparationPlan(root)
  assert.equal(explicit.ecosystem, null)
  assert.deepEqual(explicit.prepare, [])
  assert.deepEqual(explicit.problems, [])
})

it('supports go.work and fingerprints workspace manifests and Go source inputs', () => {
  rmSync(join(root, 'go.mod'))
  rmSync(join(root, 'go.sum'))
  write('go.work', 'go 1.24\nuse ./apps/api\n')
  write('apps/api/go.mod', 'module example.test/api\ngo 1.24\n')
  write('apps/api/api.go', 'package api\nconst Version = 1\n')
  assert.equal(readWorktreePreparationPlan(root).ecosystem, 'go')
  const beforeUnselectedConfig = readWorktreePreparationPlan(root).fingerprint
  write('pyproject.toml', '[project]\nname="unselected"\n')
  assert.equal(readWorktreePreparationPlan(root).fingerprint, beforeUnselectedConfig)
  for (const [path, text] of [
    ['apps/api/api.go', 'package api\nconst Version = 2\n'],
    ['apps/api/go.sum', 'example.test/dep v1.0.0 h1:fixture\n'],
    ['go.work.sum', 'example.test/dep v1.0.0/go.mod h1:fixture\n'],
  ] satisfies Array<[string, string]>) {
    const before = readWorktreePreparationPlan(root).fingerprint
    write(path, text)
    assert.notEqual(readWorktreePreparationPlan(root).fingerprint, before)
  }
})

it('rejects workspace and nested replacement paths that escape the worktree', () => {
  rmSync(join(root, 'go.mod'))
  rmSync(join(root, 'go.sum'))
  write('go.work', 'go 1.24\nuse ../outside\n')
  assert.throws(() => readWorktreePreparationPlan(root), /stay in the worktree/)

  write('go.work', 'go 1.24\nuse ./apps/api\n')
  write(
    'apps/api/go.mod',
    'module example.test/api\ngo 1.24\nreplace example.test/dep => ../../../outside\n',
  )
  assert.throws(() => readWorktreePreparationPlan(root), /stay in the worktree/)

  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'go-outside-')))
  try {
    write(
      'apps/api/go.mod',
      'module example.test/api\ngo 1.24\nreplace example.test/dep => ./linked\n',
    )
    symlinkSync(outside, join(root, 'apps/api/linked'))
    assert.throws(() => readWorktreePreparationPlan(root), /outside the worktree/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

it('pins ambient Go controls and invalidates toolchain and package graph changes', async () => {
  let version = 'go version go1.24.0 darwin/arm64'
  let packagesReady = true
  const probe = (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): string | null => {
    assert.equal(command, 'go')
    assert.equal(env['GOENV'], 'off')
    assert.equal(env['GOTOOLCHAIN'], 'local')
    assert.equal(env['GOFLAGS'], '-mod=readonly')
    assert.equal(env['GOWORK'], 'off')
    assert.equal(env['GOPROXY'], 'off')
    assert.match(env['GOMODCACHE'] ?? '', /\/go\/mod$/)
    assert.match(env['GOCACHE'] ?? '', /\/go\/build$/)
    if (args[0] === 'version') return version
    if (args[0] === 'list') return packagesReady ? 'example.test/dep\nexample.test/app' : null
    return 'all modules verified'
  }
  const options = {
    probe,
    env: { GOFLAGS: '-mod=mod', GOWORK: '/outside/go.work', GOTOOLCHAIN: 'auto' },
  }
  const first = await inspectWorktreePreparation(root, options)
  write(PREPARATION_STAMP, first.expectedFingerprint)
  assert.equal((await inspectWorktreePreparation(root, options)).state, 'ready')
  packagesReady = false
  assert.equal((await inspectWorktreePreparation(root, options)).state, 'corrupt')
  packagesReady = true
  version = 'go version go1.25.0 darwin/arm64'
  assert.equal((await inspectWorktreePreparation(root, options)).state, 'stale')
})
