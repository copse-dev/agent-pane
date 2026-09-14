import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PREPARATION_CONFIG,
  PREPARATION_STAMP,
  readWorktreePreparationPlan,
  formatPreparationApproval,
} from './worktree-preparation-plan.ts'
import { inspectWorktreePreparation } from './worktree-preparation.ts'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'python-preflight-')))
  write('pyproject.toml', '[project]\nname="ordinary-python"\nrequires-python=">=3.11"')
  write('uv.lock', 'version = 1\nrevision = 3')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
function write(path: string, text: string): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

it('detects locked uv projects without a declaration and shows the executable setup', () => {
  const plan = readWorktreePreparationPlan(root)
  assert.equal(plan.ecosystem, 'uv')
  assert.equal(plan.manager, null)
  assert.deepEqual(plan.problems, [])
  assert.deepEqual(plan.prepare, [
    { command: 'uv', args: ['sync', '--locked', '--all-packages', '--no-python-downloads'] },
  ])
  const approval = formatPreparationApproval(plan, true)
  assert.match(approval.body, /'uv' 'sync' '--locked'/)
  assert.match(approval.bodyAdvice, /executes repository code/)
  assert.doesNotMatch(approval.bodyAdvice, /lifecycle scripts disabled/)
})

it('fingerprints workspace manifests, Python constraints and uv configuration', () => {
  for (const [path, contents] of [
    ['apps/api/pyproject.toml', '[project]\nname="api"'],
    ['.python-version', '3.12'],
    ['uv.toml', 'python-preference="only-system"'],
    ['uv.lock', 'changed lock'],
  ]) {
    assert.ok(path && contents)
    const before = readWorktreePreparationPlan(root).fingerprint
    write(path, contents)
    assert.notEqual(readWorktreePreparationPlan(root).fingerprint, before)
  }
})

it('uses explicit declarations for ambiguous Python or mixed ecosystem projects', () => {
  write('poetry.lock', 'another lock')
  assert.match(readWorktreePreparationPlan(root).problems.join(' '), /Conflicting Python/)
  write('package.json', '{"packageManager":"npm@11.0.0"}')
  write('package-lock.json', '{}')
  assert.match(readWorktreePreparationPlan(root).problems.join(' '), /Multiple ecosystems/)
  write(PREPARATION_CONFIG, '{"version":1}')
  const explicit = readWorktreePreparationPlan(root)
  assert.equal(explicit.ecosystem, null)
  assert.deepEqual(explicit.prepare, [])
  assert.deepEqual(explicit.problems, [])
})

it('requires the uv project manifest and a reviewed lock', () => {
  rmSync(join(root, 'pyproject.toml'))
  assert.match(readWorktreePreparationPlan(root).problems.join(' '), /requires a pyproject.toml/)
  rmSync(join(root, 'uv.lock'))
  write('pyproject.toml', '[project]\nname="unlocked"')
  assert.ok(readWorktreePreparationPlan(root).problems.length)
})

it('rechecks locked dependencies, pins the environment location and invalidates runtime changes', async () => {
  write('.venv/bin/python', 'fixture interpreter')
  let runtime = 'Python 3.12.1'
  let synced = true
  const probe = (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): string | null => {
    assert.equal(env['UV_PROJECT_ENVIRONMENT'], join(root, '.venv'))
    assert.equal(env['UV_PYTHON_DOWNLOADS'], 'never')
    assert.equal(env['UV_OFFLINE'], 'true')
    if (command === '.venv/bin/python') return runtime
    if (args.includes('--version')) return 'uv 0.12.2'
    if (args.includes('find')) return join(root, '.venv/bin/python')
    assert.ok(args.includes('--check') && args.includes('--no-cache') && args.includes('--offline'))
    return synced ? '' : null
  }
  const options = {
    probe,
    env: { UV_PROJECT_ENVIRONMENT: '/outside', UV_PYTHON_DOWNLOADS: 'automatic' },
  }
  const first = await inspectWorktreePreparation(root, options)
  write(PREPARATION_STAMP, first.expectedFingerprint)
  assert.equal((await inspectWorktreePreparation(root, options)).state, 'ready')
  synced = false
  assert.equal((await inspectWorktreePreparation(root, options)).state, 'corrupt')
  synced = true
  runtime = 'Python 3.13.1'
  assert.equal((await inspectWorktreePreparation(root, options)).state, 'stale')
})
