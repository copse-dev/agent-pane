/**
 * R1 exit gate (`docs/plans/execution-runtime-security.md`): a thread's
 * decision export answers which principal and runtime executed every recorded
 * process.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDecisionLog } from '@shared/threads/decision-log.ts'
import { createLocalExecutionRuntime } from '../../project-sandbox/local-runtime.ts'
import { createSshExecutionRuntime } from '../ssh-workspace/ssh-runtime.ts'
import { exportDecisionLog, recordDecision } from '../security/decision-log-store.ts'
import {
  threadExecutionContextStorage,
  type ThreadExecutionContext,
} from '../thread-execution-context-store.ts'
import { withExecutionAudit } from './audit.ts'
import { recordExecutionObservation } from './audit-recorder.ts'
import { setAutomationRunCorroborator } from './principal.ts'
import type { ExecutionRuntime } from './runtime.ts'

const PROJECT = 'proj-audit'

function context(
  threadId: string,
  automation?: ThreadExecutionContext['automation'],
): ThreadExecutionContext {
  return {
    projectId: PROJECT,
    threadId,
    projectRoot: tmpdir(),
    root: tmpdir(),
    checkoutMode: 'shared',
    branch: null,
    ...(automation ? { automation } : {}),
  }
}

function finished(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => {
      resolve()
    })
  })
}

const local = withExecutionAudit(
  createLocalExecutionRuntime({
    spawn: (file, args, options) => spawn(file, [...args], options),
    wrapWithSandboxArgv: (command) =>
      Promise.resolve({ argv: ['/bin/sh', '-c', command], env: {} }),
    isSandboxEnabled: () => true,
    isSpawnableWorkingDirectory: () => Promise.resolve(true),
    releaseSandboxLease: () => {},
    brokerGitHub: () => Promise.resolve(null),
    platform: process.platform,
  }),
  () => recordExecutionObservation,
)

const ssh = withExecutionAudit(
  createSshExecutionRuntime(
    { kind: 'ssh', hostId: 'build-box', remoteRoot: tmpdir() },
    {
      spawnRemote: (commandLine, options) =>
        Promise.resolve(spawn('/bin/sh', ['-c', commandLine], { stdio: options.stdio })),
    },
  ),
  () => recordExecutionObservation,
)

async function run(
  runtime: ExecutionRuntime,
  owner: ThreadExecutionContext,
  sandbox: boolean,
): Promise<void> {
  const execution = await threadExecutionContextStorage.run(owner, () =>
    runtime.exec({
      command: { kind: 'shell', commandLine: 'exit 0' },
      cwd: tmpdir(),
      stdio: 'ignore',
      local: { sandbox, plan: () => ({ config: {} }) },
    }),
  )
  await finished(execution.child)
}

describe('execution audit export', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-exec-audit-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    setAutomationRunCorroborator(null)
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('names the principal and runtime of every recorded process', async () => {
    const automation = { scheduleId: 'nightly', scheduleName: 'Nightly', triggeredAt: 42 }
    setAutomationRunCorroborator((_p, threadId) => threadId === 'scheduled')
    const interactive = context('interactive')
    const scheduled = context('scheduled', automation)

    await run(local, interactive, true)
    await run(local, interactive, false)
    await run(ssh, interactive, true)
    await run(local, scheduled, true)

    const { path } = await exportDecisionLog(PROJECT)
    const [, ...lines] = readFileSync(path, 'utf8').trim().split('\n')
    const events = parseDecisionLog(lines.join('\n'))

    const starts = events.filter((e) => e.kind === 'process-run')
    const exits = events.filter((e) => e.kind === 'process-exit')
    assert.equal(starts.length, 4)
    assert.equal(exits.length, 4)
    for (const event of [...starts, ...exits]) {
      assert.ok(event.principalId, `${event.kind} names its principal`)
      assert.ok(event.principalKind)
      assert.ok(event.runtime, `${event.kind} names its runtime`)
      assert.equal(event.verdict, 'observed')
    }
    for (const start of starts) {
      const exit = exits.find((e) => e.processRunId === start.processRunId)
      assert.equal(exit?.exitCode, 0)
      assert.equal(exit.runtime, start.runtime)
    }

    assert.deepEqual(
      starts.map((e) => [e.threadId, e.runtime, e.principalId]).sort(),
      [
        ['interactive', 'local/contained', 'human:local'],
        ['interactive', 'local/host', 'human:local'],
        ['interactive', 'ssh:build-box', 'human:local'],
        ['scheduled', 'local/contained', 'automation:nightly@42'],
      ].sort(),
    )

    // One capability snapshot per runtime profile and thread, not per process.
    const states = events.filter((e) => e.kind === 'runtime-state')
    assert.deepEqual(
      states.map((e) => [e.threadId, e.runtime]).sort(),
      [
        ['interactive', 'local/contained'],
        ['interactive', 'local/host'],
        ['interactive', 'ssh:build-box'],
        ['scheduled', 'local/contained'],
      ].sort(),
    )
    const sshState = states.find((e) => e.runtime === 'ssh:build-box')
    assert.equal(sshState?.capabilities?.processIsolation, 'none')
    assert.equal(sshState.capabilities.filesystem, 'remote-account')
  })

  it('binds every in-turn decision to the turn principal', async () => {
    threadExecutionContextStorage.run(context('approvals'), () => {
      recordDecision({
        projectId: PROJECT,
        threadId: 'approvals',
        kind: 'shell',
        actor: 'user',
        verdict: 'approved',
        subject: 'shell command (arguments omitted)',
        remembered: true,
      })
      // A record about another thread is not attributed to this turn.
      recordDecision({
        projectId: PROJECT,
        threadId: 'elsewhere',
        kind: 'shell',
        actor: 'user',
        verdict: 'approved',
        subject: 'shell command (arguments omitted)',
      })
    })
    const { path } = await exportDecisionLog(PROJECT)
    const [, ...lines] = readFileSync(path, 'utf8').trim().split('\n')
    const events = parseDecisionLog(lines.join('\n'))
    assert.equal(events.find((e) => e.threadId === 'approvals')?.principalId, 'human:local')
    assert.equal(events.find((e) => e.threadId === 'elsewhere')?.principalId, undefined)
  })
})
