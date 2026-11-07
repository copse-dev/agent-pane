import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageGet, storageSet } from '../storage/storage.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { copseToolPermissionId } from '../security/tool-permissions.ts'
import { readWorktreePreparationPlan } from '../worktree-preparation-plan.ts'
import { reviewAutomationPreparation } from './preparation-permission.ts'

describe('automation preparation review', () => {
  let root = ''
  let previousProjects: unknown
  let previousOverrides: unknown

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'automation-preparation-review-'))
    previousProjects = storageGet('projects')
    previousOverrides = getSetting('toolPermissionOverrides', {})
    storageSet('projects', [{ id: 'project-a', name: 'Project A', path: root }])
    await setSetting('toolPermissionOverrides', {})
    writeFileSync(join(root, 'package.json'), '{"packageManager":"npm@11.12.0"}')
    writeFileSync(join(root, 'package-lock.json'), '{}')
  })

  afterEach(async () => {
    storageSet('projects', previousProjects)
    await setSetting('toolPermissionOverrides', previousOverrides)
    rmSync(root, { recursive: true, force: true })
  })

  it('previews exact argv, writes and network without executing project code', () => {
    mkdirSync(join(root, '.copse'))
    writeFileSync(
      join(root, '.copse/worktree-preparation.json'),
      JSON.stringify({ version: 1, prepare: [{ command: 'node', args: ['setup.cjs'] }] }),
    )
    writeFileSync(
      join(root, 'setup.cjs'),
      "require('node:fs').writeFileSync('executed.txt', 'ran')",
    )
    const review = reviewAutomationPreparation('project-a', { offline: true })
    assert.equal(review.projectId, 'project-a')
    assert.equal(review.projectName, 'Project A')
    assert.deepEqual(review.permission, {
      kind: 'worktree-preparation',
      toolName: 'prepare_worktree',
      directory: '.',
      planFingerprint: readWorktreePreparationPlan(root).contentFingerprint,
      offline: true,
    })
    assert.match(review.body, /'npm' 'ci'.*'--ignore-scripts'.*'--offline'/s)
    assert.match(review.body, /'node' 'setup.cjs'/)
    assert.match(review.bodyAdvice, /executes repository code/)
    assert.match(review.bodyFooter, /Network: blocked for every subprocess/)
    assert.match(review.bodyFooter, /Writes are limited to this project and Copse-managed caches/)
    assert.ok(review.bodyFooter.includes(realpathSync(root)))
    assert.equal(existsSync(join(root, 'executed.txt')), false)
    assert.equal(existsSync(join(root, 'node_modules')), false)
  })

  it('uses the requested project and canonical nested folder with an exact network scope', () => {
    const nested = join(root, 'packages/app')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'package.json'), '{"packageManager":"npm@11.12.0"}')
    writeFileSync(join(nested, 'package-lock.json'), '{}')
    storageSet('projects', [
      { id: 'project-a', name: 'Project A', path: root },
      { id: 'project-b', name: 'Project B', path: nested },
    ])
    const offline = reviewAutomationPreparation('project-a', {
      directory: './packages/app/.',
      offline: true,
    })
    const network = reviewAutomationPreparation('project-b', { offline: false })
    assert.equal(offline.permission.directory, 'packages/app')
    assert.equal(network.projectName, 'Project B')
    assert.equal(network.permission.directory, '.')
    assert.equal(network.permission.offline, false)
    assert.equal(offline.permission.planFingerprint, network.permission.planFingerprint)
    assert.match(network.bodyFooter, /Network: allowed during preparation; checks stay offline/)
    assert.doesNotMatch(network.body, /--offline/)
  })

  it('refuses a missing project, relative root, remote target or unconfigured plan', () => {
    assert.throws(() => reviewAutomationPreparation('missing', {}), /no longer available/)
    storageSet('projects', [{ id: 'project-a', name: 'Project A', path: 'relative/project' }])
    assert.throws(() => reviewAutomationPreparation('project-a', {}), /absolute local path/)
    storageSet('projects', [{ id: 'project-a', name: 'Remote', path: root, sshHost: 'host' }])
    assert.throws(() => reviewAutomationPreparation('project-a', {}), /local projects only/)
    storageSet('projects', [{ id: 'project-a', name: 'Project A', path: root }])
    rmSync(join(root, 'package-lock.json'))
    assert.throws(() => reviewAutomationPreparation('project-a', {}), /setup needs attention/)
  })

  it('reports a moved project folder as unavailable instead of a raw ENOENT', () => {
    storageSet('projects', [{ id: 'project-a', name: 'Project A', path: join(root, 'moved') }])
    assert.throws(() => reviewAutomationPreparation('project-a', {}), {
      message: 'This project’s folder is no longer available.',
    })
  })

  it('refuses traversal, absolute folders and a symlink escaping the requested project', () => {
    symlinkSync(tmpdir(), join(root, 'outside'))
    for (const directory of ['..', tmpdir(), 'outside']) {
      assert.throws(() => reviewAutomationPreparation('project-a', { directory }))
    }
  })

  for (const policy of ['ask', 'block'] as const) {
    it(`refuses an explicit ${policy} policy before exposing a selectable setup`, async () => {
      await setSetting('toolPermissionOverrides', {
        [copseToolPermissionId('prepare_worktree')]: policy,
      })
      assert.throws(
        () => reviewAutomationPreparation('project-a', {}),
        policy === 'ask' ? /Always ask/ : /blocked/,
      )
    })
  }
})
