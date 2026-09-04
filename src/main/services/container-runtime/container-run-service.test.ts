import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContainerRunProgress } from '@shared/types/container-run.ts'
import { setApiKey, setSetting } from '../storage/settings.test-shim.ts'
import { storageSet } from '../storage/storage.ts'
import { ContainerRunService, phaseFromLog } from './container-run-service.ts'
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
      promptsAttempted: 0,
      deferrals: [],
      commits: ['abc agent: did it'],
      containment: { declared: true, declineReason: null, projectSandbox: true },
      toolNames: [],
      finalText: 'Done.',
    },
    carryOutRef: 'refs/copse/runs/run-fake',
    containerExit: 0,
    teardown: 'removed',
    secretCanary: { present: false, detail: 'absent' },
  }
}

let root = ''

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'copse-run-service-'))
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
    const first = service.start({
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
    assert.equal(finished.record.carryOutRef, 'refs/copse/runs/run-fake')
    assert.deepEqual(phases.slice(0, 3), ['preparing', 'building-image', 'starting'])
    assert.ok(phases.includes('running') && phases.includes('collecting'))
    assert.equal(finished.error, null)
    assert.equal(service.isActive(THREAD), false)
  })

  it('refuses a second run while one is live, and reports a failed run', async () => {
    const pending: { release: (() => void) | null } = { release: null }
    const service = new ContainerRunService({
      ensureImage: (): Promise<void> => Promise.resolve(),
      run: (): Promise<ThreadContainerRecord> =>
        new Promise((_resolve, reject) => {
          pending.release = (): void => {
            reject(new Error('docker exploded'))
          }
        }),
    })
    service.start({
      projectId: PROJECT,
      threadId: THREAD,
      prompt: 'work',
      model: 'claude-sonnet-4-6',
      budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
    })
    await waitFor(service, THREAD, (p) => p.phase === 'starting')
    assert.throws(
      () =>
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

  it('refuses a remote project and an unresolvable model before touching Docker', () => {
    storageSet('projects', [{ id: PROJECT, path: root, sshHost: 'box' }])
    const service = new ContainerRunService({
      ensureImage: (): Promise<void> => Promise.reject(new Error('must not be called')),
      run: (): Promise<ThreadContainerRecord> => Promise.reject(new Error('must not be called')),
    })
    const base = {
      projectId: PROJECT,
      threadId: THREAD,
      prompt: 'work',
      budgets: { wallClockMs: 60_000, tokenCeiling: 10_000 },
    }
    assert.throws(() => service.start({ ...base, model: 'claude-sonnet-4-6' }), /SSH host/)
    storageSet('projects', [{ id: PROJECT, path: root }])
    assert.throws(() => service.start({ ...base, model: 'mystery' }), /cannot resolve/)
    assert.equal(service.get(THREAD), null)
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
