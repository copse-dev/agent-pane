import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { runBackgroundTool } from '../../tools/background-process-tool.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { setWorkspaceTrusted } from '../security/workspace-trust.ts'
import { clearReadOutsideProjectGrants } from '../security/read-outside-grant.ts'
import { TRUSTED_COMMANDS_SETTING } from '../security/command-routing-config.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { saveProjectThread } from '../thread-store.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { installBackgroundProcessSupervisor } from './supervised-background-process.ts'
import {
  backgroundSandboxRetryReasons,
  listBackgroundProcesses,
  startBackgroundProcess,
  stopAllBackgroundProcesses,
  stopBackgroundProcess,
} from './background-process.ts'

const OWNER = { projectId: 'background-retry', threadId: 'background-retry' }
const COMMAND = 'node scripts/run-demo.mts'

describe('explicit background sandbox escalation', () => {
  let base: string
  let root: string
  let previousStore: string | undefined
  let restoreWorkspace: () => void
  let supervisor: TaskSupervisor
  let dispose: () => void
  let registry: ToolRegistry
  let approve: boolean
  let remember: boolean
  let violations: number
  let wrappedCommand: string
  let beforeAnswer: (() => Promise<void>) | undefined
  const prompts: ApprovalRequest[] = []
  const attempts: string[] = []

  function inOwner<T>(fn: () => T, threadId = OWNER.threadId): T {
    return runWithActiveRunIdentity(threadId, () =>
      runWithThreadExecutionContext(
        {
          ...OWNER,
          threadId,
          projectRoot: root,
          root,
          checkoutMode: 'shared',
          branch: null,
        },
        fn,
      ),
    )
  }
  async function call(args: unknown, signal = new AbortController().signal): Promise<string> {
    return inOwner(
      async () => (await registry.executeNormalized('run_background', args, signal)).result,
    )
  }
  async function failed(command = COMMAND): Promise<string> {
    await call({ action: 'start', command })
    const task = inOwner(() => listBackgroundProcesses().at(-1))
    assert.ok(task)
    assert.equal(task.running, false)
    assert.equal(task.exitCode, 1)
    return task.id
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'copse-background-retry-')))
    root = join(base, 'project')
    await mkdir(root)
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'scripts/run-demo.mts'), 'console.log("outside")')
    previousStore = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = join(base, 'threads')
    await saveProjectThread(OWNER.projectId, {
      id: OWNER.threadId,
      title: 'Retries',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    })
    restoreWorkspace = setWorkspaceRootForTest(root)
    setWorkspaceTrusted(root, true)
    supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: join(base, 'threads') }),
    })
    dispose = installBackgroundProcessSupervisor(supervisor)
    await supervisor.start()
    registry = new ToolRegistry()
    registry.register(runBackgroundTool)
    approve = true
    remember = false
    violations = 1
    wrappedCommand = 'printf contained; exit 1'
    beforeAnswer = undefined
    prompts.length = 0
    attempts.length = 0
    await setSetting('autoRunSandboxCommands', true)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
    await setSetting('safetyClassifierEnabled', false)
    await setSetting(TRUSTED_COMMANDS_SETTING, [])
    await setSetting('toolPermissionOverrides', {})
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(
      SandboxManager,
      'wrapWithSandboxArgv',
      (...args: Parameters<typeof SandboxManager.wrapWithSandboxArgv>) => {
        const id = args[5]?.commandId
        assert.ok(id)
        attempts.push(id)
        return Promise.resolve({ argv: ['/bin/sh', '-c', wrappedCommand], env: {} })
      },
    )
    mock.method(SandboxManager, 'getSandboxViolationStore', () => ({
      getViolationsForCommand: (id: string): Array<Record<string, never>> =>
        attempts.includes(id) ? Array.from({ length: violations }, () => ({})) : [],
    }))
    setProjectSandboxEnabled(true)
    setApprovalHandler(async (request) => {
      prompts.push(request)
      await beforeAnswer?.()
      return { approved: approve, remember }
    })
  })

  afterEach(async () => {
    stopAllBackgroundProcesses()
    await supervisor.shutdown()
    dispose()
    setApprovalHandler(null)
    setProjectSandboxEnabled(false)
    clearReadOutsideProjectGrants()
    mock.restoreAll()
    await setSetting('toolPermissionOverrides', {})
    restoreWorkspace()
    setWorkspaceTrusted(root, false)
    if (previousStore === undefined) Reflect.deleteProperty(process.env, 'COPSE_WORKSPACE_DIR')
    else process.env['COPSE_WORKSPACE_DIR'] = previousStore
    await rm(base, { recursive: true, force: true })
  })

  it('asks before an ambiguous start and executes one outside attempt after approval', async () => {
    await call({ action: 'start', command: COMMAND, expects_sandbox_block: true })
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.title, 'Agent requests sandbox escape')
    assert.equal(prompts[0].allowTurnTreeLease, undefined)
    assert.equal(attempts.length, 0)
    assert.equal(
      inOwner(() => listBackgroundProcesses().at(-1)?.unsandboxed),
      true,
    )
  })

  it('keeps a declined hint contained and does not offer the same retry again', async () => {
    approve = false
    await call({ action: 'start', command: COMMAND, expects_sandbox_block: true })
    const task = inOwner(() => listBackgroundProcesses().at(-1))
    assert.ok(task)
    assert.equal(task.unsandboxed, false)
    assert.equal(attempts.length, 1)
    assert.equal(prompts.length, 1)
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(task.id, COMMAND, root)),
      null,
    )
  })

  it('does not offer an outside retry for a failed task with a read-only grant', async () => {
    const note = join(base, 'notes.txt')
    await writeFile(note, 'outside read')
    remember = true
    const command = `cat ${note}`
    await call({ action: 'start', command })
    const task = inOwner(() => listBackgroundProcesses().at(-1))
    assert.ok(task)
    assert.equal(task.exitCode, 1)
    assert.equal(task.unsandboxed, false)
    assert.equal(prompts[0]?.title, 'Allow read access outside of the project?')
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(task.id, command, root)),
      null,
    )
    assert.match(await call({ action: 'start', command, retry_of: task.id }), /No eligible/)
    assert.equal(prompts.length, 1)
  })

  it('ignores the hint for a fully local command', async () => {
    await call({ action: 'start', command: 'printf local', expects_sandbox_block: true })
    assert.equal(prompts.length, 0)
    assert.equal(attempts.length, 1)
  })

  it('never replays on failure and starts a separate task only after fresh retry consent', async () => {
    const id = await failed()
    assert.equal(prompts.length, 0)
    assert.equal(attempts.length, 1)
    assert.match(await call({ action: 'logs', id }), /retry_of=/)
    const result = await call({ action: 'start', command: COMMAND, retry_of: id })
    assert.match(result, /unsandboxed/)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.title, 'Run outside sandbox?')
    assert.equal(prompts[0].allowTurnTreeLease, undefined)
    assert.match(prompts[0].bodyAdvice ?? '', /partial changes/)
    const tasks = inOwner(() => listBackgroundProcesses())
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0]?.exitCode, 1)
    assert.notEqual(tasks[1]?.id, id)
    assert.equal(tasks[1]?.exitCode, 0)
    assert.match(await call({ action: 'start', command: COMMAND, retry_of: id }), /No eligible/)
  })

  it('does not start a retry after decline', async () => {
    const id = await failed()
    approve = false
    assert.match(await call({ action: 'start', command: COMMAND, retry_of: id }), /declined/)
    assert.equal(
      inOwner(() => listBackgroundProcesses().length),
      1,
    )
    assert.equal(attempts.length, 1)
  })

  it('does not start duplicate attempts from concurrent retry calls', async () => {
    const id = await failed()
    await Promise.all([
      call({ action: 'start', command: COMMAND, retry_of: id }),
      call({ action: 'start', command: COMMAND, retry_of: id }),
    ])
    assert.equal(
      inOwner(() => listBackgroundProcesses().length),
      2,
    )
  })

  it('requires current attempt evidence instead of a stale matching command', async () => {
    await failed()
    violations = 0
    const id = await failed()
    assert.equal(new Set(attempts).size, 2)
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(id, COMMAND, root)),
      null,
    )
    assert.match(await call({ action: 'start', command: COMMAND, retry_of: id }), /No eligible/)
    assert.equal(prompts.length, 0)
  })

  it('lets bounded output signatures request consent without authorizing a retry', async () => {
    violations = 0
    wrappedCommand =
      'printf "fatal: unable to access remote: CONNECT tunnel failed, response 403"; exit 1'
    const command = 'git fetch origin main'
    const id = await failed(command)
    assert.ok(inOwner(() => backgroundSandboxRetryReasons(id, command, root)))
    approve = false
    assert.match(await call({ action: 'start', command, retry_of: id }), /declined/)
    assert.equal(prompts.at(-1)?.title, 'Run outside sandbox?')
    assert.equal(
      inOwner(() => listBackgroundProcesses().length),
      1,
    )
  })

  // A failing command can print a denial signature itself. Approving the
  // retry it earns must authorize that one attempt, never a standing grant
  // that would let a later `git push` leave the sandbox unprompted.
  it('offers only a one-shot escape when retrying a forgeable denial', async () => {
    violations = 0
    wrappedCommand =
      'printf "fatal: unable to access remote: CONNECT tunnel failed, response 403"; exit 1'
    const command = 'git fetch origin main'
    // The approved retry really runs: give it a repository with no remote so
    // it fails locally instead of reaching any network or enclosing checkout.
    execFileSync('git', ['init', '-q', root])
    const id = await failed(command)
    remember = true
    assert.match(await call({ action: 'start', command, retry_of: id }), /unsandboxed/)
    const prompt = prompts.at(-1)
    assert.ok(prompt)
    assert.equal(prompt.title, 'Run outside sandbox?')
    assert.notEqual(prompt.allowRemember, true)
    assert.equal(prompt.rememberLabel, undefined)
    assert.equal(prompt.allowTurnTreeLease, undefined)
    assert.deepEqual(getSetting<string[]>(TRUSTED_COMMANDS_SETTING, []), [])
  })

  it('offers only a one-shot escape for an expected sandbox block', async () => {
    remember = true
    await call({ action: 'start', command: COMMAND, expects_sandbox_block: true })
    const prompt = prompts.at(-1)
    assert.ok(prompt)
    assert.equal(prompt.title, 'Agent requests sandbox escape')
    assert.notEqual(prompt.allowRemember, true)
    assert.equal(prompt.rememberLabel, undefined)
    assert.equal(prompt.allowTurnTreeLease, undefined)
    assert.deepEqual(getSetting<string[]>(TRUSTED_COMMANDS_SETTING, []), [])
  })

  it('rejects changed commands, roots, owners, successful, running and cancelled attempts', async () => {
    const id = await failed()
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(id, COMMAND + ' changed', root)),
      null,
    )
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(id, COMMAND, base)),
      null,
    )
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(id, COMMAND, root), 'other-thread'),
      null,
    )
    wrappedCommand = 'exit 0'
    await call({ action: 'start', command: COMMAND })
    const success = inOwner(() => listBackgroundProcesses().at(-1))
    assert.ok(success)
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(success.id, COMMAND, root)),
      null,
    )
    wrappedCommand = 'sleep 30'
    const running = await inOwner(() => startBackgroundProcess({ command: COMMAND, waitMs: 1 }))
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(running.id, COMMAND, root)),
      null,
    )
    inOwner(() => stopBackgroundProcess(running.id))
    assert.equal(
      inOwner(() => backgroundSandboxRetryReasons(running.id, COMMAND, root)),
      null,
    )
  })

  it('rechecks Blocked while escape approval is pending', async () => {
    const id = await failed()
    beforeAnswer = (): Promise<void> =>
      setSetting('toolPermissionOverrides', { 'copse:run_background': 'block' })
    await assert.rejects(call({ action: 'start', command: COMMAND, retry_of: id }), /blocked/)
    assert.equal(
      inOwner(() => listBackgroundProcesses().length),
      1,
    )
  })

  it('does not spawn after the requesting call is aborted', async () => {
    const id = await failed()
    const controller = new AbortController()
    beforeAnswer = async (): Promise<void> => {
      controller.abort()
    }
    await assert.rejects(
      call({ action: 'start', command: COMMAND, retry_of: id }, controller.signal),
    )
    assert.equal(
      inOwner(() => listBackgroundProcesses().length),
      1,
    )
  })
})
