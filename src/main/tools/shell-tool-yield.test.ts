import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { BACKGROUND_TASKS_PLUGIN_ID } from '@copse/agent/plugins/background-tasks-plugin.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { runWithDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { isProjectSandboxEnabled, setProjectSandboxEnabled } from '../project-sandbox/enabled.ts'
import { runShellTool } from './shell-tool.ts'
import {
  listBackgroundProcesses,
  stopAllBackgroundProcesses,
} from '../services/exec/background-process.ts'
import { installBackgroundProcessSupervisor } from '../services/exec/supervised-background-process.ts'
import {
  runWithBackgroundCompletionWakeHandler,
  type BackgroundCompletionWakeRequest,
} from '../services/exec/background-completion-wake.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { runWithActiveRunIdentity, setActiveRunTurnTreeId } from '../services/thread-models.ts'
import { setSetting } from '../services/storage/settings.ts'
import { copseToolPermissionId } from '../services/security/tool-permissions.ts'
import { TaskSupervisor } from '../services/supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../services/supervisor/task-store.ts'
import type { ToolExecuteResult } from '@shared/types'
import { setApprovalHandler, type ApprovalRequest } from '../services/approval.ts'
import { shellExpectedBlockEscalation } from '../services/security/permission-policy.ts'

const OWNER = { projectId: 'shell-tool-yield', threadId: 'shell-tool-yield' }
const TREE = asTurnTreeId('shell-tool-yield-tree')

function resultText(result: ToolExecuteResult): string {
  return typeof result === 'string' ? result : result.result
}

function holdApproval(): {
  entered: Promise<void>
  approve: () => void
  request: () => ApprovalRequest | undefined
} {
  let approve = (): void => {}
  const decision = new Promise<{ approved: boolean; remember: boolean }>((resolve) => {
    approve = (): void => {
      resolve({ approved: true, remember: false })
    }
  })
  let announceApproval = (): void => {}
  const entered = new Promise<void>((resolve) => {
    announceApproval = resolve
  })
  let seen: ApprovalRequest | undefined
  setApprovalHandler((request) => {
    seen = request
    announceApproval()
    return decision
  })
  return { entered, approve, request: () => seen }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('The yielded command did not finish')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('run_shell explicit yielding', () => {
  let root: string
  let supervisor: TaskSupervisor
  let dispose: () => void
  let sandboxEnabled: boolean

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-shell-tool-yield-'))
    sandboxEnabled = isProjectSandboxEnabled()
    setProjectSandboxEnabled(false)
    await setSetting('toolPermissionOverrides', {})
    supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root }),
    })
    dispose = installBackgroundProcessSupervisor(supervisor)
    await supervisor.start()
    writeFileSync(
      join(root, 'bounded.cjs'),
      [
        "const fs = require('node:fs')",
        "fs.appendFileSync('starts.txt', 'once\\n')",
        "console.log('checkpoint written')",
        'const timer = setInterval(() => {',
        " if (!fs.existsSync('release.txt')) return",
        ' clearInterval(timer)',
        " fs.writeFileSync('finished.txt', 'checked\\n')",
        " console.log('check finished')",
        ' process.exitCode = Number(process.argv[2] ?? 0)',
        '}, 20)',
      ].join('\n'),
    )
  })

  afterEach(async () => {
    stopAllBackgroundProcesses()
    await supervisor.shutdown()
    dispose()
    setApprovalHandler(null)
    mock.restoreAll()
    setProjectSandboxEnabled(sandboxEnabled)
    await setSetting('toolPermissionOverrides', {})
    rmSync(root, { recursive: true, force: true })
  })

  function withOwner<T>(fn: () => T): T {
    return runWithActiveRunIdentity(OWNER.threadId, () => {
      setActiveRunTurnTreeId(TREE)
      return runWithThreadExecutionContext(
        { ...OWNER, root, projectRoot: root, checkoutMode: 'shared', branch: 'main' },
        fn,
      )
    })
  }

  const args = { command: 'node bounded.cjs', timeout_ms: 4_000, yield_after_ms: 1_000 }

  it('offers a distinct foreground wait while preserving the existing total-deadline default', () => {
    const result = runShellTool.parameters.safeParse({ command: 'true', yield_after_ms: 1_000 })
    assert.ok(result.success)
    assert.equal(result.data.timeout_ms, 30_000)
    assert.equal(result.data.yield_after_ms, 1_000)
    assert.equal(
      runShellTool.parameters.safeParse({ command: 'true', yield_after_ms: 999 }).success,
      false,
    )
    assert.match(runShellTool.description, /same process|SAME process/)
    assert.match(runShellTool.description, /wait for the result before dependent edits/)
    assert.match(runShellTool.description, /yielding call as the only tool in its response/)
  })

  it('returns a running receipt and wakes its original turn once after a complete result', async () => {
    const wakes: BackgroundCompletionWakeRequest[] = []
    const result = await withOwner(() =>
      runWithBackgroundCompletionWakeHandler(
        async (request) => {
          assert.equal(existsSync(join(root, 'finished.txt')), true)
          assert.equal(request.alreadyObserved?.(), false)
          wakes.push(request)
          writeFileSync(join(root, 'dependent.txt'), 'after completed check\n')
          return 'completed'
        },
        () => runShellTool.execute(args, new AbortController().signal),
      ),
    )
    assert.match(resultText(result), /still running.*has not completed/)
    assert.match(resultText(result), /Completion wake is armed/)
    assert.match(resultText(result), /Wait for completion before dependent work/)
    assert.equal(existsSync(join(root, 'dependent.txt')), false)
    assert.equal(wakes.length, 0)
    writeFileSync(join(root, 'release.txt'), 'finish')
    await waitUntil(() => wakes.length === 1)
    const wake = wakes[0]
    assert.ok(wake)
    assert.equal(wake.turnTreeId, TREE)
    assert.deepEqual(wake.owner, {
      ...OWNER,
      root,
      projectRoot: root,
      checkoutMode: 'shared',
      branch: 'main',
    })
    assert.equal(wake.exitCode, 0)
    assert.equal(wake.timedOut, false)
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'once\n')
    assert.equal(readFileSync(join(root, 'dependent.txt'), 'utf8'), 'after completed check\n')
    assert.equal(listBackgroundProcesses(OWNER).length, 1)
  })

  it('rejects yielding beyond the total deadline before running the command', async () => {
    const result = await withOwner(() =>
      runShellTool.execute(
        { ...args, yield_after_ms: args.timeout_ms },
        new AbortController().signal,
      ),
    )
    assert.match(resultText(result), /must be less than timeout_ms/)
    assert.equal(existsSync(join(root, 'starts.txt')), false)
  })

  for (const ending of ['failure', 'deadline'] as const) {
    it(`reports a ${ending} through the captured completion handler exactly once`, async () => {
      const wakes: BackgroundCompletionWakeRequest[] = []
      const result = await withOwner(() =>
        runWithBackgroundCompletionWakeHandler(
          async (request) => {
            wakes.push(request)
            return 'stale'
          },
          () =>
            runShellTool.execute(
              {
                ...args,
                command: 'node bounded.cjs 3',
                timeout_ms: ending === 'deadline' ? 1_500 : args.timeout_ms,
              },
              new AbortController().signal,
            ),
        ),
      )
      assert.match(resultText(result), /still running.*has not completed/)
      if (ending === 'failure') writeFileSync(join(root, 'release.txt'), 'finish')
      await waitUntil(() => wakes.length === 1)
      const wake = wakes[0]
      assert.ok(wake)
      assert.equal(wake.turnTreeId, TREE)
      assert.equal(wake.timedOut, ending === 'deadline')
      if (ending === 'failure') assert.equal(wake.exitCode, 3)
      assert.equal(supervisor.list(OWNER.projectId)[0]?.state, 'failed')
      assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'once\n')
      assert.equal(existsSync(join(root, 'dependent.txt')), false)
    })
  }

  it('refuses a mismatched owner or cancelled startup without running the command', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(async () =>
      withOwner(() =>
        runWithBackgroundCompletionWakeHandler(
          async () => 'completed',
          () => runShellTool.execute(args, controller.signal),
        ),
      ),
    )
    const mismatched = await withOwner(() =>
      runWithActiveRunIdentity('another-thread', () => {
        setActiveRunTurnTreeId(TREE)
        return runWithBackgroundCompletionWakeHandler(
          async () => 'completed',
          () => runShellTool.execute(args, new AbortController().signal),
        )
      }),
    )
    assert.match(resultText(mismatched), /active owning turn/)
    assert.equal(existsSync(join(root, 'starts.txt')), false)
  })

  it('requires an available completion owner and supervisor before starting work', async () => {
    const noHandler = await withOwner(() =>
      runShellTool.execute(args, new AbortController().signal),
    )
    assert.match(resultText(noHandler), /active owning turn and its completion handler/)
    dispose()
    const noSupervisor = await withOwner(() =>
      runShellTool.execute(args, new AbortController().signal),
    )
    assert.match(resultText(noSupervisor), /supervision is unavailable/)
    assert.equal(existsSync(join(root, 'starts.txt')), false)
  })

  it('honors disabled background tasks without preventing an ordinary foreground call', async () => {
    const plugins = createFirstPartyPluginRegistry()
    plugins.disable(BACKGROUND_TASKS_PLUGIN_ID)
    await runWithDefaultPluginRegistry(plugins, async () => {
      const result = await withOwner(() => runShellTool.execute(args, new AbortController().signal))
      assert.match(resultText(result), /Background tasks are disabled/)
      assert.equal(existsSync(join(root, 'starts.txt')), false)
      const foreground = await withOwner(() =>
        runShellTool.execute(
          { command: 'echo ordinary foreground', timeout_ms: 1_000 },
          new AbortController().signal,
        ),
      )
      assert.match(resultText(foreground), /ordinary foreground/)
    })
  })

  for (const policy of ['ask', 'block'] as const) {
    it(`does not bypass the explicit background ${policy} policy`, async () => {
      await setSetting('toolPermissionOverrides', {
        [copseToolPermissionId('run_background')]: policy,
      })
      const result = await withOwner(() => runShellTool.execute(args, new AbortController().signal))
      assert.match(resultText(result), /cannot bypass the explicit background-task permission/)
      assert.equal(existsSync(join(root, 'starts.txt')), false)
    })
  }

  for (const policy of ['ask', 'block', 'disabled'] as const) {
    it(`rechecks background ${policy} after a held shell escape approval and before spawning`, async () => {
      setProjectSandboxEnabled(true)
      mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
      assert.equal(isProjectSandboxEnabled(), true)
      writeFileSync(join(root, 'opaque-check'), '#!/bin/sh\nexec node bounded.cjs\n', {
        mode: 0o755,
      })
      const command = './opaque-check'
      assert.equal(shellExpectedBlockEscalation(command, root, true).eligible, true)
      const plugins = createFirstPartyPluginRegistry()
      const approval = holdApproval()
      const pending = runWithDefaultPluginRegistry(plugins, () =>
        withOwner(() =>
          runWithBackgroundCompletionWakeHandler(
            async () => 'completed',
            () =>
              runShellTool.execute(
                { ...args, command, expects_sandbox_block: true },
                new AbortController().signal,
              ),
          ),
        ),
      )
      const refused = assert.rejects(
        async () => pending,
        policy === 'disabled'
          ? /Background tasks are disabled/
          : /cannot bypass the explicit background-task permission/,
      )
      await approval.entered
      assert.equal(approval.request()?.cause, 'shell-expected-sandbox-block')
      assert.equal(existsSync(join(root, 'starts.txt')), false)
      if (policy === 'disabled') plugins.disable(BACKGROUND_TASKS_PLUGIN_ID)
      else
        await setSetting('toolPermissionOverrides', {
          [copseToolPermissionId('run_background')]: policy,
        })
      approval.approve()
      await refused
      assert.equal(existsSync(join(root, 'starts.txt')), false)
      assert.deepEqual(listBackgroundProcesses(OWNER), [])
    })
  }

  it('rechecks background policy after an approved sandbox retry before starting that retry', async () => {
    setProjectSandboxEnabled(true)
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'cleanupAfterCommand', () => undefined)
    mock.method(SandboxManager, 'wrapWithSandboxArgv', () =>
      Promise.resolve({
        argv: ['/bin/sh', '-c', "echo 'controlled sandbox denial'; exit 1"],
        env: { ...process.env },
      }),
    )
    mock.method(SandboxManager.getSandboxViolationStore(), 'getViolationsForCommand', () => [
      { line: 'deny(1) network-outbound', timestamp: new Date() },
    ])
    const approval = holdApproval()
    const pending = withOwner(() =>
      runWithBackgroundCompletionWakeHandler(
        async () => 'completed',
        () => runShellTool.execute(args, new AbortController().signal),
      ),
    )
    const refused = assert.rejects(
      async () => pending,
      /cannot bypass the explicit background-task permission/,
    )
    await approval.entered
    assert.equal(approval.request()?.cause, 'shell-sandbox-retry')
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('run_background')]: 'block',
    })
    approval.approve()
    await refused
    assert.equal(existsSync(join(root, 'starts.txt')), false)
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
  })
})
