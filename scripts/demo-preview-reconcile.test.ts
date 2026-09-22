import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openPullNumbersFromPages,
  planDemoPreviewReconciliation,
  previewBytesByTargetFromTree,
  shouldDeployAfterEmptyPlan,
} from './demo-preview-reconcile.mts'

describe('demo preview reconciliation', () => {
  const workflow = readFileSync('.github/workflows/demo-preview-reconcile.yml', 'utf8')

  it('removes only exact closed-PR preview directory pairs', () => {
    const plan = planDemoPreviewReconciliation(
      [
        'main',
        'release',
        'vendor',
        'pr-12',
        'pr-12-preview',
        'pr-13',
        'pr-13-preview',
        'pr-013',
        'pr-0',
        'pr-14-other',
      ],
      new Set([12]),
      new Map([
        ['pr-12', 10],
        ['pr-12-preview', 5],
        ['pr-13', 8],
        ['pr-13-preview', 4],
      ]),
    )

    assert.deepEqual(plan, {
      openPullCount: 1,
      retainedTargets: ['pr-12', 'pr-12-preview'],
      closedTargets: ['pr-13', 'pr-13-preview'],
      previewBytesBefore: 27,
      previewBytesAfter: 15,
      reclaimedPreviewBytes: 12,
    })
  })

  it('accepts every page of the exhaustive open-pull inventory', () => {
    assert.deepEqual(
      openPullNumbersFromPages([[{ number: 12 }], [{ number: 19 }]]),
      new Set([12, 19]),
    )
    assert.deepEqual(openPullNumbersFromPages([[]]), new Set())
  })

  it('derives byte estimates from Git tree metadata', () => {
    assert.deepEqual(
      previewBytesByTargetFromTree(
        '100644 blob abc 12\tpr-12/app.js\u0000100644 blob def 8\tpr-12-preview/index.html\u0000100644 blob ghi 99\tmain/app.js\u0000',
      ),
      new Map([
        ['pr-12', 12],
        ['pr-12-preview', 8],
      ]),
    )
  })

  it('fails closed on incomplete or malformed inventory data', () => {
    assert.throws(() => openPullNumbersFromPages([]), /paginated array/)
    assert.throws(() => openPullNumbersFromPages([{ number: 12 }]), /paginated array/)
    assert.throws(() => openPullNumbersFromPages([[{ number: 0 }]]), /invalid pull number/)
  })

  it('rebuilds from a racing publisher tip before a normal push', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-demo-preview-race-'))
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const reconcile = join(root, 'reconcile')
    const publisher = join(root, 'publisher')
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Preview test',
          '-c',
          'user.email=preview-test@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd, encoding: 'utf8' },
      )
    try {
      execFileSync('git', ['init', '--bare', remote])
      execFileSync('git', ['init', seed])
      git(seed, 'config', 'user.name', 'test')
      git(seed, 'config', 'user.email', 'test@example.com')
      for (const target of ['pr-12', 'pr-12-preview', 'pr-13', 'pr-13-preview']) {
        execFileSync('mkdir', ['-p', join(seed, target)])
        writeFileSync(join(seed, target, 'index.html'), target)
      }
      writeFileSync(join(seed, 'pr-13', 'unusual\tname\nπ.txt'), 'weird')
      git(seed, 'add', '.')
      git(seed, 'commit', '-m', 'seed previews')
      git(seed, 'push', remote, 'HEAD:demo-previews')
      execFileSync('git', ['clone', '--branch', 'demo-previews', remote, reconcile])
      execFileSync('git', ['clone', '--branch', 'demo-previews', remote, publisher])
      const treeWithUnusualName = git(reconcile, 'ls-tree', '-rlz', 'HEAD')
      assert.equal(previewBytesByTargetFromTree(treeWithUnusualName).get('pr-13'), 10)

      const stale = planDemoPreviewReconciliation(
        ['pr-12', 'pr-12-preview', 'pr-13', 'pr-13-preview'],
        new Set([12]),
      )
      for (const target of stale.closedTargets) git(reconcile, 'rm', '-r', '--', target)
      git(reconcile, 'commit', '-m', 'remove closed preview')

      execFileSync('mkdir', ['-p', join(publisher, 'pr-99')])
      writeFileSync(join(publisher, 'pr-99', 'index.html'), 'new open preview')
      git(publisher, 'add', '.')
      git(publisher, 'commit', '-m', 'publish pr 99')
      git(publisher, 'push', 'origin', 'HEAD:demo-previews')
      assert.throws(() => git(reconcile, 'push', 'origin', 'HEAD:demo-previews'))

      git(reconcile, 'fetch', '--depth=1', 'origin', 'demo-previews')
      git(reconcile, 'reset', '--hard', 'FETCH_HEAD')
      const refreshed = planDemoPreviewReconciliation(
        ['pr-12', 'pr-12-preview', 'pr-13', 'pr-13-preview', 'pr-99'],
        new Set([12, 99]),
      )
      for (const target of refreshed.closedTargets) git(reconcile, 'rm', '-r', '--', target)
      git(reconcile, 'commit', '-m', 'remove closed preview from fresh tip')
      git(reconcile, 'push', 'origin', 'HEAD:demo-previews')

      const paths = execFileSync(
        'git',
        ['--git-dir', remote, 'ls-tree', '-d', '--name-only', 'demo-previews'],
        {
          encoding: 'utf8',
        },
      ).split('\n')
      assert.ok(paths.includes('pr-12'))
      assert.ok(paths.includes('pr-99'))
      assert.ok(!paths.includes('pr-13'))

      // A remote can accept a push while its client loses the response. The
      // retry then sees no stale targets but must still deploy the accepted tip.
      const acceptedRemotely = planDemoPreviewReconciliation(paths, new Set([12, 99]))
      assert.equal(shouldDeployAfterEmptyPlan(acceptedRemotely, true), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps manual reconciliation dry by default and deploys only an applied change', () => {
    assert.match(workflow, /workflow_dispatch:/)
    assert.match(workflow, /dry_run:[\s\S]*default: true[\s\S]*type: boolean/)
    assert.match(workflow, /gh api --paginate --slurp/)
    assert.match(workflow, /pull-requests: read/)
    assert.match(workflow, /git ls-tree -d --name-only HEAD/)
    assert.match(workflow, /git ls-tree -rlz HEAD/)
    assert.match(workflow, /git push origin HEAD:demo-previews/)
    assert.match(workflow, /if: needs\.reconcile\.outputs\.changed == 'true'/)
  })
})
