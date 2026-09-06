import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContainerRunProgress } from '@shared/types/container-run.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import { setApiKey, setSetting } from '../storage/settings.test-shim.ts'
import { storageSet } from '../storage/storage.ts'
import { ContainerRunService, judgeRun, phaseFromLog } from './container-run-service.ts'
import type { ThreadContainerRecord, ThreadContainerRequest } from './thread-container.ts'

const PROJECT = 'container-run-project'
const THREAD = 'container-run-thread'

function fakeRecord(threadId: string): ThreadContainerRecord {
  return {
    runtimeId: 'run-fake',
    threadId,
    startedAt: 1,
    finishedAt: 2,
    image: 'copse-worker:test',
    imageDigest: null,
    attestation: {
      runtimeId: 'run-fake',
      image: 'copse-worker:test',
      user: 1001,
      readOnlyRootfs: true,
      capDropAll: true,
      noNewPrivileges: true,
      pidsLimit: 512,
      memoryLimit: '4g',
      network: 'brokered',
      egressAllowlist: ['api.anthropic.com:443'],
      hostMounts: ['/run/copse'],
    },
    egress: [],
    result: {
      threadId,
      stopReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 5 },
      harness: 'copse',
      promptsAttempted: 0,
      deferrals: [],
      denials: [],
      commits: ['abc agent: did it'],
      containment: { declared: true, declineReason: null, projectSandbox: true },
      toolNames: [],
      finalText: 'Done.',
    },
    carryOut: { expected: true, ref: 'refs/copse/runs/run-fake', error: null },
    containerExit: 0,
    teardown: 'removed',
    cleanupError: null,
    secretCanary: { present: false, detail: 'absent' },
  }
}

/** A resolver that answers with one checkout, like the supervisor's injection. */
function checkoutAt(
  root: string,
  mode: 'shared' | 'worktree' = 'shared',
  branch = 'main',
): (projectId: string, threadId: string) => Promise<ThreadExecutionContext> {
  return (projectId: string, threadId: string): Promise<ThreadExecutionContext> =>
    Promise.resolve({
      projectId,
      threadId,
      projectRoot: root,
      root,
      checkoutMode: mode,
      branch,
    })
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo(dir: string): void {
  git(dir, ['init', '--quiet', '--initial-branch=main'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['config', 'user.email', 'test@copse.invalid'])
  writeFileSync(join(dir, 'README.md'), 'project\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'project commit'])
}

let root = ''

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'copse-run-service-'))
  // A real checkout: a container run carries the work in as a git snapshot, so
  // the service refuses a root git cannot snapshot.
  initRepo(root)
  process.env['COPSE_WORKSPACE_DIR'] = join(root, 'store')
  storageSet('projects', [{ id: PROJECT, path: root }])
  storageSet('activeProjectId', PROJECT)
  setApiKey('anthropic', 'sk-ant-test')
  await setSetting('localServerUrl', '')
})

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true })
})

describe('ContainerRunService', () => {
  it('resolves the provider, hides the key behind an env var, and publishes progress to the record', async () => {
    const seen: ThreadContainerRequest[] = []
    const keyValues: string[] = []
    const service = new ContainerRunService({
      resolveContext: checkoutAt(root),
      ensureImage: (): Promise<void> => Promise.resolve(),
      run: (request, options): Promise<ThreadContainerRecord> => {
        seen.push(request)
        keyValues.push(request.apiKeyEnv ? (process.env[request.apiKeyEnv] ?? '') : '')
        options?.onLog?.('[thread-container] starting copse-run-fake from copse-worker:test')
        options?.onStarted?.()
        keyValues.push(request.apiKeyEnv ? (process.env[request.apiKeyEnv] ?? '') : '')
        options?.onLog?.('[guest] [worker] done: completed; prompts=0 deferrals=0 commits=1')
        return Promise.resolve(fakeRecord(request.prompt))
      },
    })
    const phases: string[] = []
    service.onChanged((progress) => phases.push(progress.phase))
    const first = await service.start({
      projectId: PROJECT,
      threadId: THREAD,
      prompt: ' Fix the lint backlog ',
      model: 'claude-sonnet-4-6',
      budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
    })
    assert.equal(first.phase, 'preparing')
    assert.deepEqual(first.egressAllowlist, ['api.anthropic.com:443'])

    const finished = await waitFor(service, THREAD, (p) => p.phase === 'finished')
    assert.equal(seen.length, 1)
    const request = seen[0]
    assert.ok(request)
    assert.equal(request.workspace, root)
    assert.equal(request.prompt, 'Fix the lint backlog')
    assert.deepEqual(request.productProvider, { apiKeySlug: 'anthropic' })
    assert.equal(request.providerUrl, undefined)
    // The key was present for `docker run` and blanked once the guest held it.
    assert.deepEqual(keyValues, ['sk-ant-test', ''])
    assert.ok(request.apiKeyEnv && !request.apiKeyEnv.includes('sk-ant'))
    assert.ok(finished.record)
    assert.equal(finished.record.carryOut.ref, 'refs/copse/runs/run-fake')
    // Repeats are ordinary — the checkout lands while the run is still
    // preparing — so compare the order the phases first appear in.
    const ordered = phases.filter((phase, index) => phase !== phases[index - 1])
    assert.deepEqual(ordered, [
      'preparing',
      'building-image',
      'starting',
      'running',
      'collecting',
      'finished',
    ])
    assert.equal(finished.error, null)
    assert.equal(service.isActive(THREAD), false)
  })

  it('runs an ACP agent under its vendor key on its own domains, with no provider', async () => {
    await setSetting('registeredAcpAgents', [
      { id: 'claude-acp', title: 'Claude', command: 'claude-agent-acp', enabled: true },
    ])
    const seen: ThreadContainerRequest[] = []
    const service = new ContainerRunService({
      resolveContext: checkoutAt(root),
      ensureImage: (): Promise<void> => Promise.resolve(),
      run: (request, options): Promise<ThreadContainerRecord> => {
        seen.push(request)
        assert.equal(request.apiKeyEnv && process.env[request.apiKeyEnv], 'sk-ant-test')
        options?.onStarted?.()
        return Promise.resolve(fakeRecord(request.prompt))
      },
    })
    const first = await service.start({
      projectId: PROJECT,
      threadId: THREAD,
      prompt: 'Tidy the README',
      model: 'acp:claude-acp#claude-opus-5',
      budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
    })
    assert.ok(first.egressAllowlist.includes('*.anthropic.com:443'))
    await waitFor(service, THREAD, (p) => p.phase === 'finished')
    const request = seen[0]
    assert.ok(request)
    assert.equal(request.model, 'acp:claude-acp#claude-opus-5')
    assert.equal(request.providerUrl, undefined)
    assert.equal(request.productProvider, undefined)
    assert.ok(request.acp)
    assert.equal(request.acp.agent.id, 'claude-acp')
    assert.equal(request.acp.keyEnvName, 'ANTHROPIC_API_KEY')
    await setSetting('registeredAcpAgents', [])
  })

  it('refuses a second run while one is live, and reports a failed run', async () => {
    const pending: { release: (() => void) | null } = { release: null }
    const service = new ContainerRunService({
      resolveContext: checkoutAt(root),
      ensureImage: (): Promise<void> => Promise.resolve(),
      run: (): Promise<ThreadContainerRecord> =>
        new Promise((_resolve, reject) => {
          pending.release = (): void => {
            reject(new Error('docker exploded'))
          }
        }),
    })
    await service.start({
      projectId: PROJECT,
      threadId: THREAD,
      prompt: 'work',
      model: 'claude-sonnet-4-6',
      budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
    })
    await waitFor(service, THREAD, (p) => p.phase === 'starting')
    await assert.rejects(
      service.start({
        projectId: PROJECT,
        threadId: THREAD,
        prompt: 'again',
        model: 'claude-sonnet-4-6',
        budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
      }),
      /already has a container run/,
    )
    assert.ok(pending.release)
    pending.release()
    const failed = await waitFor(service, THREAD, (p) => p.phase === 'failed')
    assert.equal(failed.error, 'docker exploded')
  })

  it('refuses a remote project and an unresolvable model before touching Docker', async () => {
    storageSet('projects', [{ id: PROJECT, path: root, sshHost: 'box' }])
    const service = new ContainerRunService({
      resolveContext: checkoutAt(root),
      ensureImage: (): Promise<void> => Promise.reject(new Error('must not be called')),
      run: (): Promise<ThreadContainerRecord> => Promise.reject(new Error('must not be called')),
    })
    const base = {
      projectId: PROJECT,
      threadId: THREAD,
      prompt: 'work',
      budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
    }
    await assert.rejects(service.start({ ...base, model: 'claude-sonnet-4-6' }), /SSH host/)
    storageSet('projects', [{ id: PROJECT, path: root }])
    await assert.rejects(service.start({ ...base, model: 'mystery' }), /cannot resolve/)
    assert.equal(service.get(THREAD), null)
  })
})

describe('ContainerRunService checkout resolution', () => {
  it("carries in the thread's worktree, not the project checkout", async () => {
    // A project checkout and a thread worktree holding different commits and
    // different uncommitted edits: snapshotting the project root would run the
    // wrong branch and lose the thread's work.
    const worktree = join(root, '..', `${PROJECT}-worktree`)
    git(root, ['worktree', 'add', '--quiet', '-b', 'thread/work', worktree])
    writeFileSync(join(worktree, 'thread.txt'), 'thread commit\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '--quiet', '-m', 'thread commit'])
    writeFileSync(join(worktree, 'wip.txt'), 'uncommitted in the worktree\n')
    const projectHead = git(root, ['rev-parse', 'HEAD'])
    const worktreeHead = git(worktree, ['rev-parse', 'HEAD'])
    assert.notEqual(projectHead, worktreeHead)

    const seen: ThreadContainerRequest[] = []
    const service = new ContainerRunService({
      resolveContext: checkoutAt(worktree, 'worktree', 'thread/work'),
      ensureImage: (): Promise<void> => Promise.resolve(),
      run: (request): Promise<ThreadContainerRecord> => {
        seen.push(request)
        return Promise.resolve(fakeRecord(request.prompt))
      },
    })
    const progress = await service.start({
      projectId: PROJECT,
      threadId: THREAD,
      prompt: 'work',
      model: 'claude-sonnet-4-6',
      budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
    })
    await waitFor(service, THREAD, (p) => p.phase === 'finished')
    assert.equal(seen[0]?.workspace, worktree)
    assert.deepEqual(progress.checkout, {
      root: worktree,
      mode: 'worktree',
      branch: 'thread/work',
    })
    rmSync(worktree, { recursive: true, force: true })
  })

  it('refuses a checkout git cannot snapshot, and frees the thread to try again', async () => {
    // A directory with no git repository in it: no snapshot is possible.
    const notARepo = mkdtempSync(join(tmpdir(), 'copse-not-a-repo-'))
    const service = new ContainerRunService({
      resolveContext: checkoutAt(notARepo),
      ensureImage: (): Promise<void> => Promise.reject(new Error('must not be called')),
      run: (): Promise<ThreadContainerRecord> => Promise.reject(new Error('must not be called')),
    })
    await assert.rejects(
      service.start({
        projectId: PROJECT,
        threadId: THREAD,
        prompt: 'work',
        model: 'claude-sonnet-4-6',
        budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
      }),
      /not a git checkout/,
    )
    // The slot the start claimed is released, so the thread is not wedged.
    assert.equal(service.get(THREAD), null)
    assert.equal(service.isActive(THREAD), false)
    rmSync(notARepo, { recursive: true, force: true })
  })

  it('propagates a broken worktree instead of falling back to the project root', async () => {
    const service = new ContainerRunService({
      resolveContext: (): Promise<ThreadExecutionContext> =>
        Promise.reject(new Error('worktree is not registered with git')),
      ensureImage: (): Promise<void> => Promise.reject(new Error('must not be called')),
      run: (): Promise<ThreadContainerRecord> => Promise.reject(new Error('must not be called')),
    })
    await assert.rejects(
      service.start({
        projectId: PROJECT,
        threadId: THREAD,
        prompt: 'work',
        model: 'claude-sonnet-4-6',
        budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
      }),
      /not registered with git/,
    )
    assert.equal(service.get(THREAD), null)
  })
})

describe('judgeRun', () => {
  it('calls a clean run finished', () => {
    assert.deepEqual(judgeRun(fakeRecord(THREAD)), { failure: null, warnings: [] })
  })

  it('never reports success when the commits could not be fetched', () => {
    const record = fakeRecord(THREAD)
    const verdict = judgeRun({
      ...record,
      carryOut: { expected: true, ref: null, error: 'refusing to fetch into a checked-out branch' },
    })
    assert.match(verdict.failure ?? '', /could not be fetched/)
  })

  it('never reports success when the container could not be reaped', () => {
    const record = fakeRecord(THREAD)
    const failedTeardown = judgeRun({ ...record, teardown: 'failed' })
    assert.match(failedTeardown.failure ?? '', /could not be removed/)
    assert.equal(failedTeardown.warnings.length, 1)

    const hungStop = judgeRun({ ...record, cleanupError: 'the container did not exit' })
    assert.match(hungStop.failure ?? '', /did not exit/)
  })

  it('reports a leaked secret canary even on an otherwise clean run', () => {
    const verdict = judgeRun({
      ...fakeRecord(THREAD),
      secretCanary: { present: true, detail: 'canary found in out/result.json' },
    })
    assert.match(verdict.warnings.join(' '), /canary/i)
    assert.match(verdict.failure ?? '', /canary/i)
  })

  it('leads with the leaked canary even when the container also could not be reaped', () => {
    // A secret that escaped outranks a container left behind: the teardown
    // problem is still reported, but as a warning beside it, not as the
    // headline the user reads first.
    const verdict = judgeRun({
      ...fakeRecord(THREAD),
      teardown: 'failed',
      secretCanary: { present: true, detail: 'canary found in out/result.json' },
    })
    assert.match(verdict.failure ?? '', /canary/i)
    assert.match(verdict.warnings.join(' '), /could not be removed/)
  })

  it('fails when the guest reports commits but its bundle is missing', () => {
    const verdict = judgeRun({
      ...fakeRecord(THREAD),
      carryOut: { expected: false, ref: null, error: null },
    })
    assert.match(verdict.failure ?? '', /could not be fetched/)
  })

  it('rejects nonzero and unknown container exit status despite a completed result', () => {
    for (const containerExit of [1, 137, null]) {
      const verdict = judgeRun({ ...fakeRecord(THREAD), containerExit })
      assert.match(verdict.failure ?? '', /exit status/)
    }
  })

  it("carries the guest's own error through", () => {
    const record = fakeRecord(THREAD)
    assert.equal(judgeRun({ ...record, result: null }).failure, 'The guest wrote no result')
    const result = record.result
    assert.ok(result)
    assert.match(
      judgeRun({
        ...record,
        result: { ...result, stopReason: 'error', error: 'provider refused' },
      }).failure ?? '',
      /provider refused/,
    )
  })
})

describe('phaseFromLog', () => {
  it('advances on the runner lines and never leaves a terminal phase', () => {
    assert.equal(phaseFromLog('[thread-container] starting x from y', 'starting'), 'running')
    assert.equal(phaseFromLog('[guest] [worker] done: completed', 'running'), 'collecting')
    assert.equal(phaseFromLog('[thread-container] starting x', 'finished'), 'finished')
    assert.equal(phaseFromLog('[guest] chatter', 'running'), 'running')
  })
})

function waitFor(
  service: ContainerRunService,
  threadId: string,
  predicate: (progress: ContainerRunProgress) => boolean,
): Promise<ContainerRunProgress> {
  return new Promise((resolve, reject) => {
    const current = service.get(threadId)
    if (current && predicate(current)) {
      resolve(current)
      return
    }
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`timed out waiting for ${threadId}`))
    }, 5_000)
    const unsubscribe = service.onChanged((progress) => {
      if (progress.threadId === threadId && predicate(progress)) {
        clearTimeout(timer)
        unsubscribe()
        resolve(progress)
      }
    })
  })
}
