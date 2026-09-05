import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWorkerImage,
  dockerAvailable,
  listManagedRuntimes,
  runThreadInContainer,
  teardownRuntime,
} from './thread-container.ts'
import { startScriptedModelServer } from './scripted-model-server.ts'
import { bundleThreadContainerWorker } from '../../../../scripts/lib/thread-container-worker-bundle.mts'

/**
 * The whole loop, for real: a scripted model behind the egress broker drives
 * the product's headless agent inside the hardened container, and the record
 * proves the properties the plan promises — no prompt reached a handler, the
 * outward effect was queued, the host escape was refused, the contained
 * destructive command ran, the work came back as commits, the host's secret
 * never entered the guest, and the container is gone afterwards.
 *
 * Opt-in (`COPSE_THREAD_CONTAINER_E2E=1`): it builds an image and needs a
 * Docker daemon, which the ordinary unit gate must not depend on.
 */

const ENABLED = process.env['COPSE_THREAD_CONTAINER_E2E'] === '1'
const IMAGE = 'copse-worker:e2e'
const MODEL_HOST = 'model.copse.internal'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copse-tc-e2e-'))
  git(dir, ['init', '--quiet', '--initial-branch=main'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['config', 'user.email', 'test@copse.invalid'])
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'init'])
  // Uncommitted work must travel too.
  writeFileSync(join(dir, 'notes.txt'), 'uncommitted\n')
  return dir
}

describe('thread in a container (end to end)', { skip: !ENABLED }, () => {
  it('runs a thread with no prompts, defers the outward effect, and brings the work back', async () => {
    assert.equal(await dockerAvailable(), true, 'docker daemon required')
    const baseImage = process.env['COPSE_WORKER_BASE_IMAGE']
    const buildNetwork = process.env['COPSE_WORKER_BUILD_NETWORK']
    const workerBundle = await bundleThreadContainerWorker(
      join(tmpdir(), 'copse-thread-container-worker.e2e.cjs'),
    )
    await buildWorkerImage({
      image: IMAGE,
      workerBundle,
      ...(baseImage ? { baseImage } : {}),
      ...(buildNetwork ? { buildNetwork } : {}),
    })

    const model = await startScriptedModelServer([
      // In-guest destruction: the harm gate would prompt; the container tier allows.
      { kind: 'shell', command: 'rm -rf build && mkdir build && echo built > build/out.txt' },
      // Outward effect: must be deferred to the review queue, never run.
      { kind: 'shell', command: 'git push origin HEAD' },
      // Host escape: must be refused outright.
      { kind: 'shell', command: 'docker ps' },
      // Ordinary work, committed with the product's own git tool (which runs
      // outside the per-command sandbox, as the agent is told to prefer).
      // Explicit paths: `git add -A` inside a bubblewrap-contained process trips
      // over the sandbox's materialised deny mounts (linux-sandbox-rollout-followups.md §0).
      {
        kind: 'shell',
        command:
          "printf 'edited by the agent\n' >> README.md && git add README.md build/out.txt && git commit -q -m 'agent: edit readme'",
      },
      { kind: 'text', text: 'Finished the task; the push is waiting for your review.' },
    ])
    const repo = seedRepo()
    const runtimesDir = mkdtempSync(join(tmpdir(), 'copse-tc-runtimes-'))
    const canary = 'copse-canary-e2e-0123456789abcdef'
    const logs: string[] = []
    try {
      const record = await runThreadInContainer(
        {
          workspace: repo,
          prompt: 'Build the project, push it, and tidy the README.',
          model: 'scripted',
          providerUrl: `http://${MODEL_HOST}:${String(model.port)}/v1`,
          budgets: { wallClockMs: 4 * 60_000, tokenCeiling: 1_000_000 },
          egressAllowlist: [`${MODEL_HOST}:${String(model.port)}`],
          egressResolve: { [MODEL_HOST]: '127.0.0.1' },
          image: IMAGE,
          runtimesDir,
          maxSteps: 8,
        },
        { canary, onLog: (line) => logs.push(line) },
      )
      const result = record.result
      assert.ok(result, `no result written; guest log:\n${logs.join('\n')}`)
      assert.equal(result.stopReason, 'completed', result.error ?? '')

      // 1. Nobody was asked anything.
      assert.equal(result.promptsAttempted, 0)
      // 2. The container declared its containment and the gate used it.
      assert.equal(result.containment.declared, true, result.containment.declineReason ?? '')
      // 3. The outward effect is in the review queue, and only that.
      assert.equal(result.deferrals.length, 1)
      assert.match(result.deferrals[0]?.title ?? '', /Outward effect/)
      // 4. The work came back as commits the host can review; HEAD never moved.
      assert.ok(result.commits.some((line) => line.includes('agent: edit readme')))
      const carriedOutRef = record.carryOut.ref
      assert.ok(carriedOutRef, record.carryOut.error ?? 'no carry-out ref')
      assert.equal(record.carryOut.expected, true)
      assert.equal(record.carryOut.error, null)
      assert.match(git(repo, ['show', `${carriedOutRef}:README.md`]), /edited by the agent/)
      assert.match(git(repo, ['show', `${carriedOutRef}:build/out.txt`]), /built/)
      assert.match(git(repo, ['show', `${carriedOutRef}:notes.txt`]), /uncommitted/)
      assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main')
      // 5. The model was reached only through the broker, and nothing else was.
      assert.ok(record.egress.some((e) => e.event === 'connect'))
      assert.ok(record.egress.every((e) => e.origin === `${MODEL_HOST}:${String(model.port)}`))
      assert.ok(model.requests >= 5)
      // 6. The host's secret never entered the guest.
      assert.equal(record.secretCanary.present, false, record.secretCanary.detail)
      const written = readFileSync(
        join(runtimesDir, record.runtimeId, 'out', 'result.json'),
        'utf8',
      )
      // The guest reports the *names* of its environment; the host's canary
      // variable must not be among them, and its value must not appear anywhere.
      assert.ok(!written.includes('COPSE_SECRET_CANARY'))
      assert.ok(!written.includes(canary))
      // 7. The decision log and queue live in the run's own state, not the host profile.
      assert.ok(
        readFileSync(
          join(
            runtimesDir,
            record.runtimeId,
            'state',
            'workspace',
            `${record.runtimeId}-project`,
            'deferred-approvals.jsonl',
          ),
          'utf8',
        ).includes('shell-outward-effect'),
      )
      // 8. Teardown is idempotent and leaves nothing behind.
      assert.equal(record.teardown, 'removed')
      assert.equal(record.cleanupError, null)
      assert.equal(await teardownRuntime(record.runtimeId), 'already-gone')
      assert.ok(!(await listManagedRuntimes()).some((r) => r.runtimeId === record.runtimeId))
    } finally {
      await model.stop()
      rmSync(repo, { recursive: true, force: true })
      rmSync(runtimesDir, { recursive: true, force: true })
    }
  })
})
