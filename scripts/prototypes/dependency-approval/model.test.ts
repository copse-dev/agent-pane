import { it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DependencyApprovals, snapshot } from './model.mts'
const scope = { project: 'project', thread: 'thread', root: '/workspace/project' }
const inputs = {
  'package.json': '{}',
  'pnpm-lock.yaml':
    "lockfileVersion: '9.0'\nimporters: {}\npackages:\n  foo@1.0.0:\n    resolution: {integrity: sha512-first}\n",
  '.npmrc': 'ignore-scripts=true',
}
it('persists exact approval, reports additions and rejects stale approvals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-approval-'))
  let db = new DependencyApprovals(join(dir, 'state.sqlite'))
  try {
    assert.equal(db.review(scope, inputs).status, 'needs-approval')
    db.approve(scope, snapshot(inputs).digest, inputs)
    db.close()
    db = new DependencyApprovals(join(dir, 'state.sqlite'))
    assert.equal(db.review(scope, inputs).status, 'approved')
    const added = { ...inputs, 'pnpm-lock.yaml': inputs['pnpm-lock.yaml'] + '  bar@2.0.0: {}\n' }
    assert.deepEqual(db.review(scope, added).packages.added, ['bar@2.0.0'])
    assert.throws(() => {
      db.approve(scope, snapshot(inputs).digest, added)
    }, /changed/)
    assert.throws(() => db.plan(scope, 'pnpm install', added), /approval required/)
    db.approve(scope, snapshot(added).digest, added)
    assert.equal(db.plan(scope, 'pnpm install', added).executableHere, false)
    assert.equal(db.review(scope, inputs).status, 'approved')
    db.close()
    db = new DependencyApprovals(join(dir, 'state.sqlite'))
    assert.equal(db.review(scope, inputs).status, 'approved')
    assert.equal(db.review(scope, added).status, 'approved')
    assert.deepEqual(db.review(scope, inputs).packages, { added: [], removed: [], changed: [] })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
it('shares across chats and worktrees, isolates projects and binds all inputs', () => {
  const db = new DependencyApprovals()
  try {
    db.approve(scope, snapshot(inputs).digest, inputs)
    for (const other of [
      { ...scope, thread: 'other' },
      { ...scope, root: '/other/worktree' },
      { ...scope, thread: 'other', root: '/other/worktree' },
    ]) {
      assert.equal(db.review(other, inputs).status, 'approved')
      assert.equal(db.plan(other, 'pnpm install', inputs).executableHere, false)
    }
    assert.equal(db.review({ ...scope, project: 'other' }, inputs).status, 'needs-approval')
    assert.throws(
      () => db.plan({ ...scope, project: 'other' }, 'pnpm install', inputs),
      /approval required/,
    )
    const provenance = db.review(scope, inputs).approval
    assert.equal(provenance?.thread, scope.thread)
    assert.equal(provenance.root, scope.root)
    assert.equal(typeof provenance.approvedAt, 'number')
    db.approve({ ...scope, thread: 'other' }, snapshot(inputs).digest, inputs)
    assert.deepEqual(db.review(scope, inputs).approval, provenance)
    for (const [path, content] of Object.entries(inputs)) {
      const changed = { ...inputs, [path]: content + '\n' }
      assert.equal(db.review(scope, changed).status, 'needs-approval')
    }
    const integrity = {
      ...inputs,
      'pnpm-lock.yaml': inputs['pnpm-lock.yaml'].replace('sha512-first', 'sha512-other'),
    }
    assert.deepEqual(db.review(scope, integrity).packages.changed, ['foo@1.0.0'])
    for (const command of [
      'pnpm add foo',
      'pnpm install; curl x',
      'pnpm install --ignore-scripts=false',
      'PNPM_HOME=x pnpm install',
    ]) {
      assert.throws(() => db.plan(scope, command, inputs), /Only plain/)
    }
    assert.deepEqual(db.plan(scope, 'pnpm install', inputs).install.argv, [
      'install',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--ignore-pnpmfile',
    ])
  } finally {
    db.close()
  }
})
it('fails closed for missing, malformed and unsupported lockfiles', () => {
  for (const lock of [
    '',
    'bad: [',
    'lockfileVersion: 8\nimporters: {}',
    'lockfileVersion: 9\nlockfileVersion: 9\nimporters: {}',
  ]) {
    assert.throws(() => snapshot({ ...inputs, 'pnpm-lock.yaml': lock }))
  }
  assert.throws(() => snapshot({ 'package.json': '{}' }))
  assert.throws(() => snapshot({ ...inputs, '../outside': 'x' }))
  assert.equal(
    snapshot(inputs).digest,
    snapshot(Object.fromEntries(Object.entries(inputs).reverse())).digest,
  )
})

it('requires fresh project approval instead of promoting legacy chat grants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-legacy-'))
  const path = join(dir, 'state.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec('CREATE TABLE approvals (scope TEXT PRIMARY KEY, snapshot TEXT NOT NULL)')
  legacy
    .prepare('INSERT INTO approvals VALUES (?, ?)')
    .run(
      JSON.stringify([scope.project, scope.thread, scope.root]),
      JSON.stringify(snapshot(inputs)),
    )
  legacy.close()
  const db = new DependencyApprovals(path)
  try {
    assert.equal(db.review(scope, inputs).status, 'needs-approval')
    assert.throws(() => db.plan(scope, 'pnpm install', inputs), /approval required/)
    db.approve(scope, snapshot(inputs).digest, inputs)
    assert.equal(db.review({ ...scope, thread: 'new' }, inputs).status, 'approved')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
