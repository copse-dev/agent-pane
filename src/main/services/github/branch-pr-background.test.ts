import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import { mountFooterBranchStatus } from '../../../renderer/views/footer-branch-status.ts'
import { createFakeApi } from '../../../renderer/fake-api.test-support.ts'
import type { ApiClient } from '../../../preload/api.d.ts'
import type { runGh } from './gh-service.ts'
import { branchHasOpenPr, getGitBranchStatus } from './pr-context-service.ts'
import { branchPrCache } from './branch-pr-cache.ts'
import { setGhAvailableForTest, setGitAvailableForTest } from '../tool-availability.ts'

const gitOk = spawnSync('git', ['--version']).status === 0
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
}

describe('background branch PR reads', { skip: !gitOk }, () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-branch-pr-'))
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'feature'], { cwd: root }).status, 0)
    assert.equal(
      spawnSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-qm',
          'init',
        ],
        { cwd: root },
      ).status,
      0,
    )
    setGitAvailableForTest(true)
    setGhAvailableForTest(true)
    branchPrCache.invalidate()
  })
  afterEach(async () => {
    branchPrCache.invalidate()
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
    document.body.replaceChildren()
    await rm(root, { recursive: true, force: true })
  })

  for (const response of [
    { stdout: '[]', stderr: '', code: 0 },
    { stdout: '', stderr: 'authentication failed', code: 1 },
    { stdout: 'invalid JSON', stderr: '', code: 0 },
    {
      stdout: '[{"number":12,"title":"Feature","url":"https://github.com/o/r/pull/12"}]',
      stderr: '',
      code: 0,
    },
  ]) {
    it(`does not repeat GitHub reads on footer background events (${response.stdout || response.stderr})`, async () => {
      let remoteReads = 0
      const requests: Array<{ args: string[]; cwd: string | undefined }> = []
      let statusReads = 0
      let fsChanged = (): void => {}
      let workingTreeChanged = (): void => {}
      const query: ApiClient['git']['branchStatus'] = async (project, _thread, branch) => {
        statusReads++
        return getGitBranchStatus(project, branch, root, {
          runGh: async (args, options) => {
            remoteReads++
            requests.push({ args, cwd: options?.cwd })
            return response
          },
        })
      }
      const store = createStore({
        workspaceRoot: root,
        activeProjectId: 'project',
        activeThreadId: 'thread',
        threads: [
          {
            id: 'thread',
            title: 'Idle',
            status: 'idle',
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: 1,
            updatedAt: 1,
            gitBranch: 'feature',
          },
        ],
      })
      const base = createFakeApi()
      const api: ApiClient = {
        ...base,
        fs: {
          ...base.fs,
          onChanged: (callback) => {
            fsChanged = (): void => {
              callback('project', 'thread', root, null)
            }
            return () => {}
          },
        },
        git: {
          ...base.git,
          branchStatus: query,
          getDefaultBranch: async () => 'main',
          listBranches: async () => [{ name: 'feature', lastCommitDate: '2026-10-11T00:00:00Z' }],
          onWorkingTreeChanged: (callback) => {
            workingTreeChanged = (): void => {
              callback(root)
            }
            return () => {}
          },
        },
      }
      const host = document.createElement('div')
      document.body.append(host)
      const mounted = mountFooterBranchStatus(host, store, api)
      try {
        // Exercise requests that overlap, then events separated by the debounce.
        await Promise.all([query('project', 'thread', 'feature'), query('project', 'thread')])
        await settle()
        assert.equal(remoteReads, 1)
        assert.deepEqual(requests[0]?.args, [
          'pr',
          'list',
          '--head',
          'feature',
          '--state',
          'open',
          '--json',
          'number,title,url',
          '--limit',
          '1',
        ])
        assert.equal(requests[0].cwd, root)

        for (let i = 0; i < 3; i++) {
          store.emit('threads_changed')
          store.emit('thread_status_changed', 'thread', 'idle')
          fsChanged()
          workingTreeChanged()
          await new Promise<void>((resolve) => setTimeout(resolve, 550))
          await settle()
        }
        assert.ok(statusReads >= 5, 'events still refresh local checkout metadata')
        assert.equal(remoteReads, 1, 'idle events do not repeat remote PR queries')
        assert.equal(
          await branchHasOpenPr('project', 'feature', root),
          response.stdout.includes('number'),
        )
        assert.equal(remoteReads, 1, 'Changes panel shares the footer observation')
      } finally {
        mounted.destroy()
      }
    })
  }

  it('isolates project, root, and requested branch identities', async () => {
    let reads = 0
    const dependencies: { runGh: typeof runGh } = {
      runGh: async () => {
        reads++
        return { code: 0, stdout: '[]', stderr: '' }
      },
    }
    await getGitBranchStatus('local', 'feature', root, dependencies)
    await getGitBranchStatus('ssh', 'feature', root, dependencies)
    await getGitBranchStatus('local', 'other', root, dependencies)
    // Same repo, distinct checkout path identity (also a valid local Git cwd).
    await getGitBranchStatus('local', 'feature', `${root}/.`, dependencies)
    assert.equal(reads, 4)
    await getGitBranchStatus('local', 'feature', root, dependencies)
    assert.equal(reads, 4)
  })
})
