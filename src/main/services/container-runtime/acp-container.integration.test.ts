import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWorkerImage,
  dockerAvailable,
  GUEST_WORKSPACE,
  runThreadInContainer,
  teardownRuntime,
} from './thread-container.ts'
import { SCRIPTED_ACP_AGENT_SOURCE } from './scripted-acp-agent.ts'
import { bundleThreadContainerWorker } from '../../../../scripts/lib/thread-container-worker-bundle.mts'

/**
 * A thread run under an **external ACP agent** inside the container
 * (`docs/plans/thread-in-container.md`, "Agent models in the guest", phase
 * A-2). A scripted agent — a plain Node program speaking ACP over stdio,
 * carried in with the workspace — asks permission for an in-guest build (must
 * be allowed), an outward push (must be refused and recorded), and a host
 * escape (refused and recorded), then commits. The record names the harness,
 * the run's one key reached the agent and nothing else did, and the deferral
 * queue stayed empty: under an agent, outward effects are denied, never
 * queued for a replay Copse could not perform.
 *
 * Opt-in (`COPSE_THREAD_CONTAINER_E2E=1`), like its sibling: it needs Docker.
 * The image is built without the real agents baked in — this test is about
 * the policy around an agent, not about any vendor's binary.
 */

const ENABLED = process.env['COPSE_THREAD_CONTAINER_E2E'] === '1'
const IMAGE = 'copse-worker:e2e-acp'
const AGENT_FILE = 'scripted-acp-agent.cjs'
const KEY_ENV = 'COPSE_TEST_SCRIPTED_AGENT_KEY'
const KEY_VALUE = 'scripted-key-0123456789'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copse-acp-e2e-'))
  git(dir, ['init', '--quiet', '--initial-branch=main'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['config', 'user.email', 'test@copse.invalid'])
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  writeFileSync(join(dir, AGENT_FILE), SCRIPTED_ACP_AGENT_SOURCE)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'init'])
  return dir
}

describe('thread under an ACP agent in a container (end to end)', { skip: !ENABLED }, () => {
  it('admits in-guest effects, refuses outward ones without deferring, and names the harness', async () => {
    assert.equal(await dockerAvailable(), true, 'docker daemon required')
    const baseImage = process.env['COPSE_WORKER_BASE_IMAGE']
    const buildNetwork = process.env['COPSE_WORKER_BUILD_NETWORK']
    const workerBundle = await bundleThreadContainerWorker(
      join(tmpdir(), 'copse-thread-container-worker.e2e.cjs'),
    )
    await buildWorkerImage({
      image: IMAGE,
      workerBundle,
      acpAgents: [],
      ...(baseImage ? { baseImage } : {}),
      ...(buildNetwork ? { buildNetwork } : {}),
    })

    const repo = seedRepo()
    const runtimesDir = mkdtempSync(join(tmpdir(), 'copse-acp-runtimes-'))
    const canary = 'copse-canary-acp-0123456789abcdef'
    const logs: string[] = []
    process.env[KEY_ENV] = KEY_VALUE
    try {
      const record = await runThreadInContainer(
        {
          workspace: repo,
          prompt: 'Build the project, push it, and tidy the README.',
          model: 'acp:scripted',
          acp: {
            agent: {
              id: 'scripted',
              title: 'Scripted agent',
              command: 'node',
              args: [`${GUEST_WORKSPACE}/${AGENT_FILE}`],
              sandbox: false,
              enabled: true,
            },
            keyEnvName: 'SCRIPTED_AGENT_KEY',
          },
          apiKeyEnv: KEY_ENV,
          budgets: { wallClockMs: 4 * 60_000, tokenCeiling: 1_000_000 },
          egressAllowlist: [],
          image: IMAGE,
          runtimesDir,
          maxSteps: 4,
        },
        { canary, onLog: (line) => logs.push(line) },
      )
      const result = record.result
      assert.ok(result, `no result written; guest log:\n${logs.join('\n')}`)
      assert.equal(result.stopReason, 'completed', result.error ?? '')

      // 1. The record says who ran the loop.
      assert.deepEqual(result.harness, { acp: 'scripted' })
      // 2. Nobody was asked anything, and nothing was queued for a replay
      //    Copse could not perform.
      assert.equal(result.promptsAttempted, 0)
      assert.equal(result.deferrals.length, 0)
      // 3. The push and the escape were refused, and the record says so.
      assert.equal(result.denials.length, 2)
      assert.ok(result.denials.some((entry) => /push|remote/.test(entry.reasons.join(' '))))
      assert.ok(result.denials.some((entry) => /docker|host/.test(entry.reasons.join(' '))))
      // 4. The agent saw exactly the run's key under its own name, no canary,
      //    and its own view of what it was and was not allowed to do agrees.
      const carriedOutRef = record.carryOut.ref
      assert.ok(carriedOutRef, record.carryOut.error ?? 'no carry-out ref')
      const agentEnv = git(repo, ['show', `${carriedOutRef}:agent-env.txt`])
      assert.match(agentEnv, new RegExp(`^key=${KEY_VALUE}$`, 'm'))
      assert.match(agentEnv, /^canary=absent$/m)
      assert.match(agentEnv, /^build=allowed$/m)
      assert.match(agentEnv, /^push=refused$/m)
      assert.match(agentEnv, /^escape=refused$/m)
      // 5. The allowed work came back as a commit.
      assert.ok(result.commits.some((line) => line.includes('agent: edit readme')))
      assert.match(git(repo, ['show', `${carriedOutRef}:README.md`]), /edited by the agent/)
      assert.match(git(repo, ['show', `${carriedOutRef}:build/out.txt`]), /built/)
      // 6. Nothing reached out: no egress was allowlisted and none was asked for.
      assert.equal(record.attestation.network, 'none')
      assert.equal(record.egress.length, 0)
      // 7. The host's canary never entered, and the run's key never came back.
      assert.equal(record.secretCanary.present, false, record.secretCanary.detail)
      assert.ok(!JSON.stringify(record).includes(KEY_VALUE))
      // 8. Teardown is clean.
      assert.equal(record.teardown, 'removed')
      assert.equal(record.cleanupError, null)
      assert.equal(await teardownRuntime(record.runtimeId), 'already-gone')
    } finally {
      process.env[KEY_ENV] = ''
      rmSync(repo, { recursive: true, force: true })
      rmSync(runtimesDir, { recursive: true, force: true })
    }
  })
})
